import { readSync } from 'node:fs';
import type { FnDecl, Stmt, VarSym } from './ast.ts';
import { interpret } from './interpreter.ts';
import type { Frame, Interpreter } from './interpreter.ts';
import type { Frontend } from './pipeline.ts';
import { format } from './runtime.ts';
import type { IO } from './runtime.ts';

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

export function debug(fe: Frontend, entry: string, io: IO): number {
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

  const where = (s: Stmt) => src.locate(s.span.start);
  const say = (t: string) => process.stdout.write(t + '\n');

  const show = (it: Interpreter, s: Stmt) => {
    const at = where(s);
    const fn = it.depth > 0 ? it.names[it.depth - 1] : '<main>';
    say(`${fn} ${at.file}:${at.line}   ${src.lineText(at.line, at.file).trim()}`);
  };

  const value = (it: Interpreter, f: Frame, name: string): string | null => {
    const d = it.depth > 0 ? it.decls[it.depth - 1] : null;
    let vs = d ? cache.get(d) : mainLocals;
    if (d && !vs) {
      vs = varsOf(d, d.body);
      cache.set(d, vs);
    }
    // the innermost declaration wins when a name is reused
    const local = [...(vs ?? [])].reverse().find(v => v.name === name && v.where === 'local');
    const sym = local ?? globals.find(v => v.name === name);
    if (!sym) return null;
    const v = sym.where === 'global' ? it.globals[sym.slot] : f.locals[sym.slot];
    return v === null || v === undefined ? '<not set yet>' : format(v, sym.ty);
  };

  const prompt = (it: Interpreter, f: Frame, s: Stmt) => {
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
        case 'n': case 'next': mode = 'next'; nextDepth = it.depth; return;
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
          const v = value(it, f, arg);
          say(v === null ? `no variable '${arg}' here` : `${arg} = ${v}`);
          break;
        }
        case 'l': case 'locals': {
          const d = it.depth > 0 ? it.decls[it.depth - 1] : null;
          const vs = d ? varsOf(d, d.body) : mainLocals;
          const names = [...new Set(vs.map(v => v.name))];
          if (names.length === 0) say('(no locals)');
          for (const n of names) say(`${n} = ${value(it, f, n)}`);
          break;
        }
        case 'bt': case 'where': {
          for (let d = it.depth; d >= 1; d--) say(`#${it.depth - d} ${it.names[d - 1]}`);
          say(`#${it.depth} <main>`);
          break;
        }
        case 'list': {
          const at = where(s);
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

  const hook = (s: Stmt, f: Frame, it: Interpreter) => {
    if (quit || SKIP.has(s.k)) return;
    const at = where(s);
    if (at.file !== entry) return; // library code is stepped over
    if (at.line === lastLine && it.depth === lastDepth) return;
    const hit = breaks.has(at.line);
    const stop = hit || mode === 'step' || (mode === 'next' && it.depth <= nextDepth);
    if (!stop) return;
    lastLine = at.line;
    lastDepth = it.depth;
    if (hit) say(`breakpoint, line ${at.line}`);
    show(it, s);
    prompt(it, f, s);
    if (quit) throw new DebugQuit();
  };

  say('lumen debugger, type help for the commands');
  try {
    interpret(prog, io, hook);
  } catch (e) {
    if (e instanceof DebugQuit) return 0;
    throw e;
  }
  say('program finished');
  return 0;
}

class DebugQuit {}
