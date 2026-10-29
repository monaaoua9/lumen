#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { CompileError, ExitSignal, RuntimeError, Source, render, renderAll } from './diagnostics.ts';
import type { Segment } from './diagnostics.ts';
import { bundle } from './modules.ts';
import { DeepNesting, checked, execute, frontend, toBytecode, toC } from './pipeline.ts';
import type { Engine } from './pipeline.ts';
import { disassemble } from './bytecode.ts';
import { Repl, incomplete } from './repl.ts';
import { EXPLAIN, explain } from './explain.ts';
import { format } from './fmt.ts';
import { serve } from './lsp.ts';
import { programArgs } from './runtime.ts';
import { createInterface } from 'node:readline';
import { findManifest, init as pkgInit, install as pkgInstall, update as pkgUpdate } from './package.ts';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const USAGE = `lumen <command> <file.lum> [options]

commands
  check    static analysis only (types, scopes, lints)
  run      analyze, then execute        [--engine interp|vm|c]  (default: vm)   [-- program args]
           lumen run -e 'print(1 + 2);'   runs code given on the command line
  disasm   print the bytecode
  test     run every fn test_*() in the file, assert() marks failures   [--engine interp|vm|c] [--only substr]
  emit-c   translate to C              [-o out.c]
  build    emit C and compile it with gcc/clang/cc   [-o out]
  ast      dump the typed AST as JSON
  bench    run on both engines and compare timings
  repl     interactive prompt (no file)
  fmt      re-indent files   [--write] overwrite, [--check] exit 1 if a file would change
  init     create a lumen.toml here   [name]
  install  fetch the git dependencies listed in lumen.toml, as locked in lumen.lock
  update   fetch them again from their refs and rewrite the lock   [name]
  lsp      language server on stdin/stdout (diagnostics, hover, definition, formatting)
  explain  describe an error or warning code, e.g. explain E003 (no code: list them all)

options
  -O          constant folding (arithmetic and pure builtins on literals) / dead branch removal before codegen
  --json      (check) machine readable diagnostics
  --Werror    (check) treat warnings as errors
`;

const full = process.argv.slice(2);
// everything after `--` belongs to the program (args() reads it)
const split = full.indexOf('--');
const args = split < 0 ? full : full.slice(0, split);
if (split >= 0) programArgs.push(...full.slice(split + 1));
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const color = !!process.stdout.isTTY && !process.env.NO_COLOR;

// mingw defaults to a 2MB stack, not enough for 10000 nested calls
const stackFlag = process.platform === 'win32' ? ['-Wl,--stack,67108864'] : [];

function main(): number | Promise<number> {
  const cmd = args[0];
  // lumen run -e 'print(1 + 2);' writes the code to a scratch file and runs that (any command that takes a file)
  const e = args.indexOf('-e');
  if (e > 0 && args[e + 1] !== undefined && ['run', 'check', 'ast', 'disasm', 'emit-c', 'bench', 'test'].includes(cmd)) {
    const dir = mkdtempSync(join(tmpdir(), 'lumen-e-'));
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'expr.lum'), args[e + 1] + '\n');
    args.splice(e, 2, join(dir, 'expr.lum'));
  }
  if (cmd === '--version' || cmd === '-v') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`lumen ${pkg.version}
`);
    return 0;
  }
  if (cmd === 'init') {
    const dir = process.cwd();
    try {
      process.stdout.write(`created ${pkgInit(dir, args[1] ?? basename(dir))}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
  }
  if (cmd === 'install' || cmd === 'update') {
    const m = findManifest(process.cwd());
    if (!m) {
      process.stderr.write('no lumen.toml here or in a parent directory (lumen init creates one)\n');
      return 1;
    }
    const lines = cmd === 'update' ? pkgUpdate(m, args[1]) : pkgInstall(m);
    process.stdout.write(lines.length ? lines.join('\n') + '\n' : 'no dependencies\n');
    return lines.some(l => l.includes('failed') || l.includes('missing')) ? 1 : 0;
  }
  if (cmd === 'repl') return repl();
  if (cmd === 'fmt') return fmtFiles();
  if (cmd === 'lsp') {
    serve();
    return new Promise<number>(() => {}); // runs until the editor sends exit
  }
  if (cmd === 'explain') {
    const code = args[1];
    const text = code ? explain(code) : null;
    if (text) process.stdout.write(text);
    else if (!code) process.stdout.write(Object.entries(EXPLAIN).map(([c, e]) => `${c}  ${e.title}`).join('\n') + '\n');
    else process.stderr.write(`no explanation for '${code}'\n`);
    return code && !text ? 1 : 0;
  }
  const file = args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-o' && args[i - 1] !== '--engine' && args[i - 1] !== '--only');
  if (!cmd || cmd === '-h' || cmd === '--help' || !file) {
    process.stderr.write(USAGE);
    return cmd && !file && cmd !== '-h' && cmd !== '--help' ? 2 : 0;
  }

  if (cmd === 'check' || cmd === 'test') {
    // several files: each is checked on its own, the worst exit code wins
    const files = args.filter((x, i) => i > 0 && !x.startsWith('-') && args[i - 1] !== '-o' && args[i - 1] !== '--engine' && args[i - 1] !== '--only');
    if (files.length > 1) return files.reduce((worst, f) => {
      if (!flag('--json')) process.stdout.write(`== ${f}
`);
      return Math.max(worst, runFile(f, cmd) as number);
    }, 0);
  }
  return runFile(file, cmd);
}

function runFile(file: string, cmd: string): number | Promise<number> {
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
  if (warnings.length && cmd !== 'ast' && cmd !== 'test') process.stderr.write(renderAll(fe.source, warnings, color) + '\n\n');

  try {
    switch (cmd) {
      case 'run': {
        const eng = (opt('--engine') ?? 'vm') as Engine | 'c';
        if (eng === 'c') return runNative(toC(fe));
        execute(fe, eng, { out: s => process.stdout.write(s) });
        return 0;
      }
      case 'test': {
        // every `fn test_*()` runs on its own: the file plus one call appended
        const only = opt('--only');
        const names = [...text.matchAll(/^fn (test_\w+)\s*\(\s*\)/gm)].map(m => m[1]).filter(n => !only || n.includes(only));
        if (names.length === 0) {
          process.stderr.write(`no matching test_ functions in ${name}
`);
          return 1;
        }
        const eng = (opt('--engine') ?? 'vm') as Engine;
        let failed = 0;
        for (const t of names) {
          let out = '';
          let fe2: ReturnType<typeof checked> | undefined;
          try {
            const call = `
${t}();
`;
            // the call belongs to the entry file, which is the last segment
            const segs = segments.map((sg, i) => (i === segments.length - 1 ? { ...sg, end: sg.end + call.length } : sg));
            fe2 = checked(text + call, name, flag('-O'), segs);
            execute(fe2, eng, { out: s => { out += s; } });
            process.stdout.write(`ok    ${t}
`);
          } catch (e) {
            if (!(e instanceof RuntimeError || e instanceof ExitSignal)) throw e;
            failed++;
            let why = e instanceof RuntimeError ? e.message : `exit ${e.code}`;
            // where the test made the failing call
            const site = e instanceof RuntimeError ? (e.trace?.find(x => x.fn === t && x.span)?.span ?? e.span) : undefined;
            if (site && fe2) {
              const at = fe2.source.locate(site.start);
              why += ` (${at.file}:${at.line}:${at.col})`;
            }
            process.stdout.write(`FAIL  ${t}: ${why}
${out}`);
          }
        }
        process.stdout.write(`${names.length - failed} passed, ${failed} failed
`);
        return failed ? 1 : 0;
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
      // long (usually recursive) traces keep the innermost and outermost frames
      const tr = e.trace ?? [];
      const shown = tr.length > 12 ? [...tr.slice(0, 6), null, ...tr.slice(-5)] : tr;
      for (const t of shown) {
        if (!t) { msg += `\n  ... ${tr.length - 11} more calls`; continue; }
        if (!t.span) continue;
        const at = fe.source.locate(t.span.start);
        msg += `\n  in ${t.fn.replace(/^.*\$/, '')} (${at.file}:${at.line}:${at.col})`;
      }
      process.stderr.write(msg + '\n');
      return 1;
    }
    throw e;
  }
}

function fmtFiles(): number {
  const files = args.slice(1).filter(a => !a.startsWith('-'));
  if (files.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  let dirty = 0;
  for (const f of files) {
    const before = readFileSync(f, 'utf8');
    const after = format(before);
    if (after === before.replace(/\r\n/g, '\n')) continue;
    dirty++;
    if (flag('--write')) writeFileSync(f, after);
    else if (flag('--check')) process.stdout.write(`${f} would be reformatted\n`);
    else process.stdout.write(after);
  }
  return flag('--check') && dirty > 0 ? 1 : 0;
}

function repl(): Promise<number> {
  const r = new Repl();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ', terminal: !!process.stdin.isTTY });
  let buf = '';
  if (process.stdin.isTTY) rl.prompt();
  rl.on('line', line => {
    if (r.done) return;
    buf += line + '\n';
    if (incomplete(buf)) {
      rl.setPrompt('. ');
    } else {
      process.stdout.write(r.feed(buf));
      buf = '';
      rl.setPrompt('> ');
      if (r.done) return rl.close();
    }
    if (process.stdin.isTTY) rl.prompt();
  });
  return new Promise(res => rl.on('close', () => res(0)));
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
    const r = spawnSync(cc, ['-O2', '-o', out, cfile, '-lm', ...stackFlag], { stdio: 'inherit' });
    if (r.error) continue; // not installed
    if (r.status === 0) {
      process.stdout.write(`built ${out} (via ${cc}, source kept in ${cfile})\n`);
      return 0;
    }
    process.stderr.write(`error: ${cc} failed${r.status === null ? ` (${r.signal ?? 'crashed'})` : ` with exit code ${r.status}`}\n`);
    return r.status || 1;
  }
  process.stderr.write(`no C compiler found; C source is in ${cfile}\n`);
  return 1;
}

// compiles to a temp dir and runs the binary, so stdin/stdout/exit status pass straight through
function runNative(csrc: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-c-'));
  try {
    const exe = join(dir, process.platform === 'win32' ? 'prog.exe' : 'prog');
    const cfile = join(dir, 'prog.c');
    writeFileSync(cfile, csrc);
    for (const cc of ['gcc', 'clang', 'cc']) {
      const r = spawnSync(cc, ['-O2', '-o', exe, cfile, '-lm', ...stackFlag], { stdio: ['ignore', 'inherit', 'inherit'] });
      if (r.error) continue;
      if (r.status !== 0) {
        process.stderr.write(`error: ${cc} failed${r.status === null ? ` (${r.signal ?? 'crashed'})` : ` with exit code ${r.status}`}\n`);
        return r.status || 1;
      }
      return spawnSync(exe, programArgs, { stdio: 'inherit' }).status ?? 1;
    }
    process.stderr.write('no C compiler found\n');
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// the tree-walking interpreter recurses on the host stack, so `run --engine interp` gets a thread with a big one
// (that is what lets it reach the same call depth cap as the other engines)
function onBigStack() {
  const w = new Worker(new URL(import.meta.url), { argv: full, resourceLimits: { stackSizeMb: 256 } });
  w.on('message', (m: { code: number }) => { process.exitCode = m.code; });
  w.on('error', e => { throw e; });
}

if (isMainThread && args[0] === 'run' && args[args.indexOf('--engine') + 1] === 'interp') {
  onBigStack();
} else {
  new Promise<number>(done => done(main())).then(c => {
    if (isMainThread) process.exitCode = c;
    else parentPort!.postMessage({ code: c });
  }, e => {
    // a very long expression chain: nothing ran yet, so the whole command can start over with room to recurse
    if (e instanceof DeepNesting && isMainThread) onBigStack();
    else if (e instanceof RangeError) {
      // a later pass (code generation) ran out of stack even here
      process.stderr.write('error: this program nests expressions or blocks too deeply\n');
      if (isMainThread) process.exitCode = 1;
      else parentPort!.postMessage({ code: 1 });
    } else throw e;
  });
}
