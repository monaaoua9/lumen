import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeError } from '../src/diagnostics.ts';
import { ENGINES, runSrc } from './helpers.ts';

// small deterministic generator so a failure can be replayed from its seed
function rng(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 48271) % 2147483647;
    return s % n;
  };
}

function intExpr(r: (n: number) => number, depth: number): string {
  if (depth === 0 || r(4) === 0) return r(3) === 0 ? `(0 - v${r(9)})` : `v${r(12)}`;
  const a = intExpr(r, depth - 1);
  const b = intExpr(r, depth - 1);
  switch (r(9)) {
    case 0: return `(${a} + ${b})`;
    case 1: return `(${a} - ${b})`;
    case 2: return `(${a} * ${b})`;
    case 3: return `(${a} / ${b})`;
    case 4: return `(${a} % ${b})`;
    case 5: return `min(${a}, ${b})`;
    case 6: return `max(${a}, ${b})`;
    case 7: return `abs(${a})`;
    default: return `(if ${a} < ${b} { ${a} } else { ${b} })`;
  }
}

function program(seed: number, lines: number): string {
  const r = rng(seed);
  // vars, so the analyzer cannot fold a division by zero away at compile time
  const out: string[] = Array.from({ length: 12 }, (_, i) => `var v${i} = ${i};`);
  for (let i = 0; i < lines; i++) {
    const e = intExpr(r, 3);
    out.push(r(3) === 0 ? `print(${e} > ${intExpr(r, 2)} || ${e} == 0);` : `print(${e});`);
  }
  return out.join('\n') + '\n';
}

// a runtime error stops the program, so each expression gets its own run
function inProcess(src: string): string {
  const outs = ENGINES.map(([e, o]) => {
    try {
      return runSrc(src, e, o);
    } catch (err) {
      if (err instanceof RuntimeError) return `ERR:${err.message}`;
      throw err;
    }
  });
  for (const o of outs.slice(1)) assert.equal(o, outs[0], src);
  return outs[0];
}

test('random int expressions agree on interp, vm and both optimized', () => {
  for (let seed = 1; seed <= 150; seed++) inProcess(program(seed, 1));
});

test('random int expressions agree with the C backend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-diff-'));
  try {
    for (let seed = 500; seed < 506; seed++) {
      const src = program(seed, 12);
      let want: string;
      try {
        want = runSrc(src, 'vm');
      } catch (err) {
        if (!(err instanceof RuntimeError)) throw err;
        continue; // an early trap would hide the later lines, the in-process test covers those
      }
      const file = join(dir, `p${seed}.lum`);
      writeFileSync(file, src);
      const r = spawnSync(process.execPath, ['src/cli.ts', 'run', file, '--engine', 'c'], { encoding: 'utf8' });
      assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, src);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function strExpr(r: (n: number) => number, depth: number): string {
  const words = ['"lumen"', '"a,b,,c"', '"  pad "', '""', '"Hello World"', '"aaa"'];
  if (depth === 0 || r(4) === 0) return words[r(words.length)];
  const a = strExpr(r, depth - 1);
  const b = strExpr(r, depth - 1);
  switch (r(10)) {
    case 0: return `(${a} + ${b})`;
    case 1: return `upper(${a})`;
    case 2: return `lower(${a})`;
    case 3: return `trim(${a})`;
    case 4: return `substr(${a}, v${r(4)}, v${r(4)})`;
    case 5: return `replace(${a}, ${b}, "x")`;
    case 6: return `repeat(${a}, v${r(4)})`;
    case 7: return `join(split(${a}, ","), "|")`;
    case 8: return `str(find(${a}, ${b}))`;
    default: return `${a}[v${r(4)}..v${r(4) + 2}]`;
  }
}

test('random string expressions agree on every in-process engine', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed * 7);
    const header = Array.from({ length: 12 }, (_, i) => `var v${i} = ${i};`).join('\n');
    inProcess(`${header}\nprint(${strExpr(r, 3)});\nprint(len(${strExpr(r, 2)}) > ${r(5)});\nprint(${strExpr(r, 2)} < ${strExpr(r, 2)});\n`);
  }
});

test('random string expressions agree with the C backend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-diffs-'));
  try {
    let compared = 0;
    for (let seed = 1; seed <= 40 && compared < 6; seed++) {
      const r = rng(seed * 11);
      const header = Array.from({ length: 12 }, (_, i) => `var v${i} = ${i};`).join('\n');
      const src = `${header}\nprint(${strExpr(r, 3)});\nprint(${strExpr(r, 3)});\nprint(${strExpr(r, 2)} >= ${strExpr(r, 2)});\n`;
      let want: string;
      try {
        want = runSrc(src, 'vm');
      } catch (err) {
        if (!(err instanceof RuntimeError)) throw err;
        continue;
      }
      const file = join(dir, `s${seed}.lum`);
      writeFileSync(file, src);
      const out = spawnSync(process.execPath, ['src/cli.ts', 'run', file, '--engine', 'c'], { encoding: 'utf8' });
      assert.equal(out.stdout.replace(/\r\n/g, '\n'), want, src);
      compared++;
    }
    assert.ok(compared >= 3, `only ${compared} programs ran to the end`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function floatExpr(r: (n: number) => number, depth: number): string {
  const lits = ['0.5', '1.0', '2.5', '0.1', '100.0', '3.0', '1000000.0', '0.001', '7.25'];
  if (depth === 0 || r(4) === 0) return r(5) === 0 ? `float(v${r(12)})` : lits[r(lits.length)];
  const a = floatExpr(r, depth - 1);
  const b = floatExpr(r, depth - 1);
  switch (r(8)) {
    case 0: return `(${a} + ${b})`;
    case 1: return `(${a} - ${b})`;
    case 2: return `(${a} * ${b})`;
    case 3: return `(${a} / ${b})`;
    case 4: return `floor(${a})`;
    case 5: return `ceil(${a})`;
    case 6: return `sqrt(abs(${a}))`;
    default: return `max(${a}, ${b})`;
  }
}

test('random float expressions agree on every engine including C', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-difff-'));
  try {
    const header = Array.from({ length: 12 }, (_, i) => `var v${i} = ${i};`).join('\n');
    let src = header + '\n';
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed * 13);
      src += `print(${floatExpr(r, 3)});\n`;
    }
    const want = inProcess(src);
    const file = join(dir, 'f.lum');
    writeFileSync(file, src);
    const out = spawnSync(process.execPath, ['src/cli.ts', 'run', file, '--engine', 'c'], { encoding: 'utf8' });
    assert.equal(out.stdout.replace(/\r\n/g, '\n'), want);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function arrayProgram(seed: number): string {
  const r = rng(seed * 17);
  const out = ['let a: int[] = [];', 'let b: int[] = [3, 1, 2];'];
  for (let i = 0; i < 30; i++) {
    const t = r(2) === 0 ? 'a' : 'b';
    const v = r(20);
    switch (r(11)) {
      case 0: out.push(`push(${t}, ${v});`); break;
      case 1: out.push(`if len(${t}) > 0 { print(pop(${t})); }`); break;
      case 2: out.push(`if len(${t}) > ${v % 5} { insert(${t}, ${v % 5}, ${v}); }`); break;
      case 3: out.push(`if len(${t}) > ${v % 5} { print(remove(${t}, ${v % 5})); }`); break;
      case 4: out.push(`sort(${t});`); break;
      case 5: out.push(`reverse(${t});`); break;
      case 6: out.push(`print(${t});`); break;
      case 7: out.push(`print(contains(${t}, ${v}));`); break;
      case 8: out.push(`if len(${t}) >= 2 { print(${t}[0..2]); }`); break;
      case 9: out.push(`for i, x in ${t} { if x > ${v} { print(i); break; } }`); break;
      default: out.push(`print(len(${t}) * ${v});`); break;
    }
  }
  out.push('print(a);', 'print(b);');
  return out.join('\n') + '\n';
}

test('random array operations agree on every engine including C', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-diffa-'));
  try {
    for (let seed = 1; seed <= 40; seed++) {
      const src = arrayProgram(seed);
      const want = inProcess(src);
      if (seed > 5) continue; // C compiles slowly, a few programs are enough
      const file = join(dir, `a${seed}.lum`);
      writeFileSync(file, src);
      const out = spawnSync(process.execPath, ['src/cli.ts', 'run', file, '--engine', 'c'], { encoding: 'utf8' });
      assert.equal(out.stdout.replace(/\r\n/g, '\n'), want, src);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
