import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frontend } from '../src/pipeline.ts';

const PIECES = [
  'fn', 'struct', 'enum', 'match', 'let', 'var', 'if', 'else', 'while', 'return', 'break', 'continue',
  'x', 'y', 'P', 'Color', 'int', 'float', 'string', 'bool', '1', '2.5', '"s"', 'true', 'false', '_',
  '(', ')', '{', '}', '[', ']', ',', ';', ':', '=', '==', '=>', '|', '||', '&&', '.', '+', '-', '*', '/', '%', '<', '!', '+=',
  'trait', 'impl', 'pub', 'dyn', 'import', 'T', 'Box', '>', 'self', 'Shape', 'from', '"m.lum"',
];

// tiny deterministic PRNG so failures are reproducible
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

test('frontend never crashes or hangs on token soup', () => {
  const rand = rng(42);
  for (let n = 0; n < 12000; n++) {
    const len = 1 + Math.floor(rand() * 30);
    const src = Array.from({ length: len }, () => PIECES[Math.floor(rand() * PIECES.length)]).join(' ');
    try {
      frontend(src);
    } catch (e) {
      assert.fail(`crashed on: ${src}\n${e}`);
    }
  }
});

test('frontend survives truncated real programs', () => {
  const dir = new URL('../examples/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.lum'))) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    for (let cut = 0; cut < text.length; cut += 17) {
      try {
        frontend(text.slice(0, cut));
      } catch (e) {
        assert.fail(`crashed on ${f} cut at ${cut}\n${e}`);
      }
    }
  }
});

const cli = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8' });

test('cli: run, check and exit codes', () => {
  const ok = cli('run', 'examples/fib.lum');
  assert.equal(ok.status, 0);
  assert.ok(ok.stdout.includes('fib(15) = 610'));

  const bad = cli('check', 'examples/errors.lum');
  assert.equal(bad.status, 1);
  assert.ok(bad.stdout.includes('error[E003]'));

  const json = cli('check', 'examples/lints.lum', '--json');
  assert.equal(json.status, 0);
  assert.ok(Array.isArray(JSON.parse(json.stdout)));

  assert.equal(cli('check', 'examples/lints.lum', '--Werror').status, 1);
  assert.equal(cli('run', 'examples/overflow.lum').status, 1);
  assert.equal(cli().status, 0);
});

test('modules: imports are bundled and errors point at the right file', () => {
  const ok = cli('run', 'examples/modules/main.lum');
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim().split(/\r?\n/)[0], '5.0');

  const dir = mkdtempSync(join(tmpdir(), 'lumen-mod-'));
  try {
    writeFileSync(join(dir, 'lib.lum'), 'fn f(): int {\n  return "s";\n}\n');
    writeFileSync(join(dir, 'main.lum'), 'import "lib.lum";\nprint(f());\n');
    const bad = cli('check', join(dir, 'main.lum'));
    assert.equal(bad.status, 1);
    assert.ok(bad.stdout.includes('lib.lum:2:10'), bad.stdout);

    writeFileSync(join(dir, 'gone.lum'), 'import "nope.lum";\n');
    const missing = cli('check', join(dir, 'gone.lum'));
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes('P004'), missing.stderr);

    // only `pub` items cross file boundaries
    writeFileSync(join(dir, 'priv.lum'), 'fn hidden(): int { return 1; }\npub fn shown(): int { return hidden(); }\n');
    writeFileSync(join(dir, 'use_priv.lum'), 'import "priv.lum";\nprint(shown());\nprint(hidden());\n');
    const priv = cli('check', join(dir, 'use_priv.lum'));
    assert.equal(priv.status, 1);
    assert.ok(priv.stdout.includes('E027') && priv.stdout.includes("'hidden'") && !priv.stdout.includes("'shown'"), priv.stdout);

    // module.item is checked against the file the item lives in
    writeFileSync(join(dir, 'q_main.lum'), 'import "lib.lum";\nimport "priv.lum";\nprint(priv.shown());\nprint(lib.shown());\nprint(priv.nope());\n');
    const q = cli('check', join(dir, 'q_main.lum'));
    assert.equal(q.status, 1);
    assert.ok(q.stdout.includes("'shown' is declared in priv.lum, not in module 'lib'"), q.stdout);
    assert.ok(q.stdout.includes("module 'priv' has no item 'nope'"), q.stdout);

    // the same name in two modules is fine as long as uses are qualified or local
    writeFileSync(join(dir, 'm1.lum'), 'pub fn f(): int { return 1; }\nfn g(): int { return f(); }\npub fn h(): int { return g(); }\n');
    writeFileSync(join(dir, 'm2.lum'), 'pub fn f(): int { return 2; }\nfn g(): int { return f(); }\npub fn h(): int { return g(); }\n');
    writeFileSync(join(dir, 'ns_ok.lum'), 'import "m1.lum";\nimport "m2.lum";\nprint(m1.f() * 10 + m2.f());\nprint(m1.h() * 10 + m2.h());\n');
    const ns = cli('run', join(dir, 'ns_ok.lum'));
    assert.equal(ns.status, 0, ns.stderr);
    assert.deepEqual(ns.stdout.trim().split(/\r?\n/), ['12', '12']);
    writeFileSync(join(dir, 'ns_bad.lum'), 'import "m1.lum";\nimport "m2.lum";\nprint(f());\n');
    const amb = cli('check', join(dir, 'ns_bad.lum'));
    assert.equal(amb.status, 1);
    assert.ok(amb.stdout.includes('P006') || amb.stderr.includes('P006'), amb.stdout + amb.stderr);

    // two modules may each keep a global of the same name, even with a local of that name inside
    writeFileSync(join(dir, 'g1.lum'), 'var base = 10;\npub fn a(): int { let base = 1; return base + 1; }\npub fn c(): int { base += 5; return base; }\n');
    writeFileSync(join(dir, 'g2.lum'), 'let base = 20;\npub fn b(): int { return base + 2; }\n');
    writeFileSync(join(dir, 'g_main.lum'), 'import "g1.lum";\nimport "g2.lum";\nprint(g1.a() + g2.b());\nprint(g1.c() + g1.c());\n');
    const gl = cli('run', join(dir, 'g_main.lum'));
    assert.equal(gl.status, 0, gl.stderr);
    assert.deepEqual(gl.stdout.trim().split(/\r?\n/), ['24', '35']);

    // a cycle must not hang
    writeFileSync(join(dir, 'a.lum'), 'import "b.lum";\nfn a(): int { return 1; }\n');
    writeFileSync(join(dir, 'b.lum'), 'import "a.lum";\nfn b(): int { return 2; }\nprint(b());\n');
    assert.equal(cli('run', join(dir, 'a.lum')).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('frontend survives token-level mutations of real programs', () => {
  const dir = new URL('../examples/', import.meta.url);
  const rand = rng(7);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.lum'))) {
    const words = readFileSync(new URL(f, dir), 'utf8').split(/(\s+)/);
    for (let n = 0; n < 60; n++) {
      const copy = [...words];
      for (let k = 0; k < 3; k++) {
        const at = Math.floor(rand() * copy.length);
        const r = rand();
        if (r < 0.4) copy[at] = '';
        else if (r < 0.8) copy[at] = PIECES[Math.floor(rand() * PIECES.length)];
        else copy.splice(at, 0, copy[Math.floor(rand() * copy.length)]);
      }
      try {
        frontend(copy.join(''));
      } catch (e) {
        assert.fail(`crashed on a mutation of ${f}\n${copy.join('')}\n${e}`);
      }
    }
  }
});

test('string builtins trap the same way on every engine', () => {
  const cases: [string, string][] = [
    ['print(substr("abc", 2, 5));', 'substring out of range'],
    ['print(substr("abc", -1, 1));', 'substring out of range'],
    ['print(substr("hé", 2, 1));', 'splits a character'],
    ['print(split("abc", ""));', 'empty separator'],
    ['print(byte("abc", 3));', 'byte index out of range'],
    ['print(chr(0));', 'chr expects'],
  ];
  const dir = mkdtempSync(join(tmpdir(), 'lumen-str-'));
  try {
    for (const [src, msg] of cases) {
      const f = join(dir, 't.lum');
      writeFileSync(f, src);
      for (const engine of ['interp', 'vm']) {
        const r = cli('run', f, '--engine', engine);
        assert.equal(r.status, 1, `${engine}: ${src}`);
        assert.ok((r.stdout + r.stderr).includes(msg), `${engine}: ${src}\n${r.stderr}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stdin builtins agree on every engine', () => {
  const input = 'abc\n\nxy\r\nlast';
  for (const engine of ['interp', 'vm']) {
    const r = spawnSync(process.execPath, ['src/cli.ts', 'run', 'examples/io/stdin.lum', '--engine', engine], { encoding: 'utf8', input });
    assert.equal(r.stdout, '3\n9\n', engine);
  }
  const none = spawnSync(process.execPath, ['src/cli.ts', 'run', 'examples/io/stdin.lum'], { encoding: 'utf8', input: '' });
  assert.equal(none.stdout, '0\n0\n');
});

test('exit(code) sets the status and keeps earlier output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-exit-'));
  try {
    const f = join(dir, 't.lum');
    writeFileSync(f, 'print("before");\nif len("ab") == 2 { exit(3); }\nprint("after");\n');
    for (const engine of ['interp', 'vm']) {
      const r = cli('run', f, '--engine', engine);
      assert.equal(r.status, 3, engine);
      assert.equal(r.stdout, 'before\n', engine);
    }
    writeFileSync(f, 'exit(300);\n');
    const bad = cli('run', f);
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes('exit code must be 0..255'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repl: expressions print, state carries over, bad input is rejected', () => {
  const input = 'let x = 4\nx * 2\nfn sq(n: int): int {\n  return n * n;\n}\nsq(x) + 1\nnope\nx / 0\nx + 1\n';
  const r = spawnSync(process.execPath, ['src/cli.ts', 'repl'], { encoding: 'utf8', input });
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), [
    '8', '17', "error[E001]: cannot find variable 'nope'", 'error[E012]: division by zero', '5',
  ]);
});

test('slice traps out of range on every engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-slice-'));
  try {
    const f = join(dir, 't.lum');
    writeFileSync(f, 'print(slice([1, 2], 1, 5));\n');
    for (const engine of ['interp', 'vm']) {
      const r = cli('run', f, '--engine', engine);
      assert.equal(r.status, 1, engine);
      assert.ok(r.stderr.includes('slice out of range'), engine);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
