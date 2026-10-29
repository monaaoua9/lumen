import { CompileError, RuntimeError, Source } from './diagnostics.ts';
import type { Diagnostic, Segment } from './diagnostics.ts';
import type { Program } from './ast.ts';
import { parse } from './parser.ts';
import { analyze } from './analyzer.ts';
import { optimize } from './optimizer.ts';
import { interpret } from './interpreter.ts';
import { compile } from './compiler.ts';
import { run as runVm } from './vm.ts';
import { emitC } from './cgen.ts';
import type { Module } from './bytecode.ts';
import type { IO } from './runtime.ts';

export interface Frontend {
  source: Source;
  program: Program;
  diagnostics: Diagnostic[];
  ok: boolean;
}

// lex -> parse -> analyze. analysis is skipped when the parse already failed,
// half-built trees only produce noise
export function frontend(text: string, name = '<input>', segments: Segment[] = []): Frontend {
  try {
    return frontend0(text, name, segments);
  } catch (e) {
    // the recursive descent ran out of stack: say so instead of dumping a JS stack trace
    if (!(e instanceof RangeError)) throw e;
    const d: Diagnostic = { severity: 'error', code: 'P001', message: 'this program nests expressions or blocks too deeply', span: { start: 0, end: Math.min(1, text.length) } };
    return { source: new Source(text, name, segments), program: parse('', []).program, diagnostics: [d], ok: false };
  }
}

function frontend0(text: string, name: string, segments: Segment[]): Frontend {
  const source = new Source(text, name, segments);
  const { program, diags } = parse(text, segments);
  const parseFailed = diags.some(d => d.severity === 'error');
  const all = parseFailed ? diags : [...diags, ...analyze(program, segments)];
  const inStd = (d: Diagnostic) => segments.some(s => s.std && d.span.start >= s.start && d.span.start <= s.end);
  const diagnostics = all.filter(d => d.severity === 'error' || !inStd(d));
  return { source, program, diagnostics, ok: !diagnostics.some(d => d.severity === 'error') };
}

// same, but throws on errors so backends never see an untyped tree
export function checked(text: string, name = '<input>', opt = false, segments: Segment[] = []): Frontend {
  const fe = frontend(text, name, segments);
  if (!fe.ok) throw new CompileError(fe.diagnostics);
  if (opt) optimize(fe.program);
  return fe;
}

export type Engine = 'interp' | 'vm';

export function execute(fe: Frontend, engine: Engine, io: IO) {
  if (engine === 'interp') interpret(fe.program, io);
  else runVm(compile(fe.program), io);
}

export function toBytecode(fe: Frontend): Module {
  return compile(fe.program);
}

export function toC(fe: Frontend): string {
  return emitC(fe.program, off => {
    const at = fe.source.locate(off);
    return `${at.file}:${at.line}:${at.col}`;
  });
}

export { CompileError, RuntimeError };
