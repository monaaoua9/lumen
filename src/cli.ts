#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { CompileError, ExitSignal, RuntimeError, Source, render, renderAll } from './diagnostics.ts';
import type { Segment } from './diagnostics.ts';
import { bundle } from './modules.ts';
import { checked, execute, frontend, toBytecode, toC } from './pipeline.ts';
import type { Engine } from './pipeline.ts';
import { disassemble } from './bytecode.ts';

const USAGE = `lumen <command> <file.lum> [options]

commands
  check    static analysis only (types, scopes, lints)
  run      analyze, then execute        [--engine interp|vm]  (default: vm)
  disasm   print the bytecode
  emit-c   translate to C              [-o out.c]
  build    emit C and compile it with gcc/clang/cc   [-o out]
  ast      dump the typed AST as JSON
  bench    run on both engines and compare timings

options
  -O          constant folding / dead branch removal before codegen
  --json      (check) machine readable diagnostics
  --Werror    (check) treat warnings as errors
`;

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const color = !!process.stdout.isTTY && !process.env.NO_COLOR;

function main(): number {
  const cmd = args[0];
  const file = args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-o' && args[i - 1] !== '--engine');
  if (!cmd || cmd === '-h' || cmd === '--help' || !file) {
    process.stderr.write(USAGE);
    return cmd && !file && cmd !== '-h' && cmd !== '--help' ? 2 : 0;
  }

  const name = basename(file);
  const b = bundle(file);
  if (b.diags.length) {
    process.stderr.write(renderAll(new Source(b.text, name, b.segments), b.diags, color) + '\n');
    return 1;
  }
  const { text, segments } = b;

  if (cmd === 'check') return check(text, name, segments);

  let fe;
  try {
    fe = checked(text, name, flag('-O'), segments);
  } catch (e) {
    if (e instanceof CompileError) {
      const { frontend: f } = { frontend };
      const src = f(text, name, segments).source;
      process.stderr.write(renderAll(src, e.diags, color) + '\n');
      const n = e.diags.filter(d => d.severity === 'error').length;
      process.stderr.write(`\n${n} error${n === 1 ? '' : 's'}, aborting\n`);
      return 1;
    }
    throw e;
  }

  const warnings = fe.diagnostics.filter(d => d.severity === 'warning');
  if (warnings.length && cmd !== 'ast') process.stderr.write(renderAll(fe.source, warnings, color) + '\n\n');

  try {
    switch (cmd) {
      case 'run': {
        const eng = (opt('--engine') ?? 'vm') as Engine;
        execute(fe, eng, { out: s => process.stdout.write(s) });
        return 0;
      }
      case 'disasm':
        process.stdout.write(disassemble(toBytecode(fe)) + '\n');
        return 0;
      case 'ast':
        process.stdout.write(JSON.stringify(fe.program.body, (k, v) => (k === 'sym' || k === 'fn' ? undefined : v), 2) + '\n');
        return 0;
      case 'emit-c': {
        const c = toC(fe);
        const out = opt('-o');
        if (out) writeFileSync(out, c);
        else process.stdout.write(c);
        return 0;
      }
      case 'build':
        return build(toC(fe), opt('-o') ?? name.replace(/\.lum$/, '') + (process.platform === 'win32' ? '.exe' : ''));
      case 'bench':
        return bench(fe);
      default:
        process.stderr.write(`unknown command '${cmd}'\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    if (e instanceof RuntimeError) {
      let msg = `runtime error: ${e.message}`;
      if (e.span) {
        const { line, col, file: where } = fe.source.locate(e.span.start);
        msg += `\n  --> ${where}:${line}:${col}\n   | ${fe.source.lineText(line, where)}`;
      }
      process.stderr.write(msg + '\n');
      return 1;
    }
    throw e;
  }
}

function check(text: string, name: string, segments: Segment[]): number {
  const fe = frontend(text, name, segments);
  const ds = fe.diagnostics;
  const errors = ds.filter(d => d.severity === 'error').length;
  const warns = ds.length - errors;

  if (flag('--json')) {
    const out = ds.map(d => ({ ...d, ...fe.source.locate(d.span.start) }));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else if (ds.length) {
    process.stdout.write(ds.map(d => render(fe.source, d, color)).join('\n\n') + '\n\n');
  }
  if (!flag('--json')) {
    process.stdout.write(errors || warns ? `${errors} error(s), ${warns} warning(s)\n` : 'ok: no issues found\n');
  }
  return errors || (flag('--Werror') && warns) ? 1 : 0;
}

function build(csrc: string, out: string): number {
  const cfile = out.replace(/(\.exe)?$/, '') + '.c';
  writeFileSync(cfile, csrc);
  for (const cc of ['gcc', 'clang', 'cc']) {
    const r = spawnSync(cc, ['-O2', '-o', out, cfile, '-lm'], { stdio: 'inherit' });
    if (r.error) continue; // not installed
    if (r.status === 0) {
      process.stdout.write(`built ${out} (via ${cc}, source kept in ${cfile})\n`);
      return 0;
    }
    return r.status ?? 1;
  }
  process.stderr.write(`no C compiler found; C source is in ${cfile}\n`);
  return 1;
}

function bench(fe: ReturnType<typeof frontend>): number {
  for (const eng of ['interp', 'vm'] as const) {
    let sink = 0;
    const t0 = performance.now();
    execute(fe, eng, { out: s => { sink += s.length; } });
    const ms = performance.now() - t0;
    process.stdout.write(`${eng.padEnd(6)} ${ms.toFixed(1)} ms  (${sink} bytes of output)\n`);
  }
  return 0;
}

process.exitCode = main();
