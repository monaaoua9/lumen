import { readSync } from 'node:fs';
import type { FnDecl, Stmt, VarSym } from './ast.ts';
import type { Span } from './diagnostics.ts';
import { interpret } from './interpreter.ts';
import { runJs } from './jsgen.ts';
import type { Frontend } from './pipeline.ts';
import { format } from './runtime.ts';
import type { IO, Value } from './runtime.ts';

// what the debugger needs from whichever engine is running the program
interface Probe {
  depth: number;
  name(d: number): string; // function running at call depth d (1 is the outermost call)
  decl(d: number): FnDecl | null;
  local(slot: number): Value;
  global(slot: number): Value;
}

// one line from stdin, read a byte at a time so nothing is buffered past it
function readCommand(): string | null {
  const buf = Buffer.alloc(1);
  let line = '';
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((e as NodeJS.ErrnoException).code === 'EOF') n = 0;
      else throw e;
    }
    if (n === 0) return line === '' ? null : line.trim();
    const c = String.fromCharCode(buf[0]);
    if (c === '\n') return line.trim();
    if (c !== '\r') line += c;
  }
}

// every variable a function declares (parameters and lets), by name, for `print` and `locals`
function varsOf(f: FnDecl | null, body: Stmt[]): VarSym[] {
  const out: VarSym[] = [];
  const seen = new Set<object>();
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) return n.forEach(walk);
    const o = n as Record<string, unknown>;
    if (o.k === 'let' && o.sym) out.push(o.sym as VarSym);
    if (o.k === 'lambda' || o.k === 'fn') return; // their own frames
    for (const [key, v] of Object.entries(o)) if (key !== 'sym' && key !== 'fn' && key !== 'decl' && key !== 'origin') walk(v);
  };
  if (f) for (const p of f.params) if (p.sym) out.push(p.sym);
  walk(body);
  return out.filter(v => !v.name.includes('$'));
}

const SKIP = new Set(['block', 'fn', 'struct', 'enum', 'break', 'continue']);

export type DebugEngine = 'interp' | 'js';

export function debug(fe: Frontend, entry: string, io: IO, engine: DebugEngine = 'js'): number {
  const src = fe.source;
  const prog = fe.program;
  const breaks = new Set<number>();
  let mode: 'step' | 'next' | 'run' = 'step';
  let nextDepth = 0;
  let lastLine = -1;
  let lastDepth = -1;
  let quit = false;

  const topVars = varsOf(null, prog.body);
  const globals = topVars.filter(v => v.where === 'global');
  const mainLocals = topVars.filter(v => v.where === 'local');
  const cache = new Map<FnDecl, VarSym[]>();

  const say = (t: string) => process.stdout.write(t + '\n');

  const varsHere = (p: Probe): VarSym[] => {
    const d = p.depth > 0 ? p.decl(p.depth) : null;
    if (!d) return mainLocals;
    let vs = cache.get(d);
    if (!vs) {
      vs = varsOf(d, d.body);
      cache.set(d, vs);
    }
    return vs;
  };

  const value = (p: Probe, name: string): string | null => {
    // the innermost declaration wins when a name is reused
    const local = [...varsHere(p)].reverse().find(v => v.name === name && v.where === 'local');
    const sym = local ?? globals.find(v => v.name === name);
    if (!sym) return null;
    const v = sym.where === 'global' ? p.global(sym.slot) : p.local(sym.slot);
    return v === null || v === undefined ? '<not set yet>' : format(v, sym.ty);
  };

  const prompt = (p: Probe, span: Span) => {
    for (;;) {
      process.stdout.write('(lumen-db) ');
      const line = readCommand();
      if (line === null) {
        quit = true;
        return;
      }
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(' ');
      switch (cmd) {
        case 's': case 'step': mode = 'step'; return;
        case 'n': case 'next': mode = 'next'; nextDepth = p.depth; return;
        case 'c': case 'continue': case 'r': case 'run': mode = 'run'; return;
        case 'q': case 'quit': quit = true; return;
        case 'b': case 'break': {
          const n = Number(arg);
          if (!Number.isInteger(n) || n < 1) say('usage: break <line>');
          else {
            breaks.add(n);
            say(`breakpoint at line ${n}`);
          }
          break;
        }
        case 'd': case 'delete':
          if (arg === '') breaks.clear();
          else breaks.delete(Number(arg));
          say('ok');
          break;
        case 'p': case 'print': {
          const v = value(p, arg);
          say(v === null ? `no variable '${arg}' here` : `${arg} = ${v}`);
          break;
        }
        case 'l': case 'locals': {
          const names = [...new Set(varsHere(p).map(v => v.name))];
          if (names.length === 0) say('(no locals)');
          for (const n of names) say(`${n} = ${value(p, n)}`);
          break;
        }
        case 'bt': case 'where': {
          for (let d = p.depth; d >= 1; d--) say(`#${p.depth - d} ${p.name(d)}`);
          say(`#${p.depth} <main>`);
          break;
        }
        case 'list': {
          const at = src.locate(span.start);
          for (let n = Math.max(1, at.line - 3); n <= at.line + 3; n++) {
            const t = src.lineText(n, at.file);
            if (t === '' && n > at.line) break;
            say(`${n === at.line ? '>' : ' '} ${String(n).padStart(3)}  ${t}`);
          }
          break;
        }
        case 'h': case 'help': case '?':
          say('step (s)  next (n)  continue (c)  break <line>  delete [line]  print <name> (p)  locals (l)  bt  list  quit (q)');
          break;
        case '':
          break;
        default:
          say(`unknown command '${cmd}' (help lists them)`);
      }
    }
  };

  const onStep = (span: Span, kind: string, p: Probe) => {
    if (quit || SKIP.has(kind)) return;
    const at = src.locate(span.start);
    if (at.file !== entry) return; // library code is stepped over
    if (at.line === lastLine && p.depth === lastDepth) return;
    const hit = breaks.has(at.line);
    const stop = hit || mode === 'step' || (mode === 'next' && p.depth <= nextDepth);
    if (!stop) return;
    lastLine = at.line;
    lastDepth = p.depth;
    if (hit) say(`breakpoint, line ${at.line}`);
    say(`${p.depth > 0 ? p.name(p.depth) : '<main>'} ${at.file}:${at.line}   ${src.lineText(at.line, at.file).trim()}`);
    prompt(p, span);
    if (quit) throw new DebugQuit();
  };

  say('lumen debugger, type help for the commands');
  try {
    if (engine === 'js') runJs(prog, io, onStep);
    else {
      interpret(prog, io, (s, f, it) => onStep(s.span, s.k, {
        depth: it.depth,
        name: d => it.names[d - 1],
        decl: d => (d > 0 ? it.decls[d - 1] : null),
        local: slot => f.locals[slot],
        global: slot => it.globals[slot],
      }));
    }
  } catch (e) {
    if (e instanceof DebugQuit) return 0;
    throw e;
  }
  say('program finished');
  return 0;
}

class DebugQuit {}
