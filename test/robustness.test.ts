import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { frontend } from '../src/pipeline.ts';
import { format } from '../src/fmt.ts';
import { Repl } from '../src/repl.ts';

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

    // the same trait name in two modules, used through module.Trait and dyn
    writeFileSync(join(dir, 't1.lum'), 'pub trait Named { fn name(self): string; }\npub struct A { x: int }\nimpl Named for A { fn name(self): string { return "a"; } }\n');
    writeFileSync(join(dir, 't2.lum'), 'pub trait Named { fn name(self): string; }\npub struct B { x: int }\nimpl Named for B { fn name(self): string { return "b"; } }\n');
    writeFileSync(join(dir, 't_main.lum'), 'import "t1.lum";\nimport "t2.lum";\nfn one<T: t1.Named>(t: T): string { return t.name(); }\nprint(one(t1.A { x: 1 }));\nlet d: dyn t2.Named = t2.B { x: 2 };\nprint(d.name());\n');
    const tr = cli('run', join(dir, 't_main.lum'));
    assert.equal(tr.status, 0, tr.stderr);
    assert.deepEqual(tr.stdout.trim().split(/\r?\n/), ['a', 'b']);

    // a trait without pub stays private to its file
    writeFileSync(join(dir, 'hid.lum'), 'trait Hidden { fn h(self): int; }\npub struct Q { x: int }\nimpl Hidden for Q { fn h(self): int { return 1; } }\n');
    writeFileSync(join(dir, 'use_hid.lum'), 'import "hid.lum";\nfn go<T: Hidden>(t: T): int { return t.h(); }\nprint(go(hid.Q { x: 1 }));\n');
    const hid = cli('check', join(dir, 'use_hid.lum'));
    assert.equal(hid.status, 1);
    assert.ok(hid.stdout.includes('E027') && hid.stdout.includes("trait 'Hidden'"), hid.stdout);

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
    ['print(replace("abc", "", "x"));', 'replace of an empty string'],
    ['print(repeat("a", -1));', 'repeat count is negative'],
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

test('run --engine c compiles and runs natively', { skip: !['gcc', 'clang', 'cc'].some(c => !spawnSync(c, ['--version']).error) }, () => {
  const r = spawnSync(process.execPath, ['src/cli.ts', 'run', 'examples/io/stdin.lum', '--engine', 'c'], { encoding: 'utf8', input: 'abc\nxy' });
  assert.equal(r.stdout.replace(/\r\n/g, '\n'), '2\n5\n');
  assert.equal(cli('run', 'examples/overflow.lum', '--engine', 'c').status, 1);
});

test('explain: every diagnostic code the compiler can emit has an entry', () => {
  const used = new Set<string>();
  for (const f of ['lexer', 'parser', 'analyzer', 'modules']) {
    const text = readFileSync(new URL(`../src/${f}.ts`, import.meta.url), 'utf8');
    for (const m of text.matchAll(/'([ELPW]\d{3})'/g)) used.add(m[1]);
  }
  const r = cli('explain');
  const listed = new Set(r.stdout.split(/\r?\n/).map(l => l.split(' ')[0]));
  for (const code of used) assert.ok(listed.has(code), `${code} has no explanation`);
  assert.ok(cli('explain', 'E003').stdout.includes('type mismatch'));
  assert.equal(cli('explain', 'E999').status, 1);
});

test('insert and remove trap out of bounds on every engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-ins-'));
  try {
    const f = join(dir, 't.lum');
    for (const [src, msg] of [['let a = [1]; insert(a, 3, 2);', 'insert index out of bounds'], ['let a = [1]; remove(a, 1);', 'index out of bounds']]) {
      writeFileSync(f, src);
      for (const engine of ['interp', 'vm']) {
        const r = cli('run', f, '--engine', engine);
        assert.equal(r.status, 1, `${engine}: ${src}`);
        assert.ok(r.stderr.includes(msg), `${engine}: ${src}\n${r.stderr}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fmt: re-indents by bracket depth and is idempotent', () => {
  const messy = 'fn f(a: int): int {\n\t  let s = "{ not a block";\n\n\n\n  if a > 0 {\nreturn 1; // }\n    }\n   return 2;\n}\n';
  const once = format(messy);
  assert.equal(once, 'fn f(a: int): int {\n  let s = "{ not a block";\n\n  if a > 0 {\n    return 1; // }\n  }\n  return 2;\n}\n');
  assert.equal(format(once), once);
  assert.equal(format('/* a\n     b */\nlet x = [\n1,\n2,\n];\n'), '/* a\n     b */\nlet x = [\n  1,\n  2,\n];\n');
});

test('fmt: every shipped example is already formatted', () => {
  const files = ['examples', 'examples/modules', 'examples/namespaces', 'examples/io', 'examples/std', 'lib'].flatMap(d =>
    readdirSync(new URL(`../${d}/`, import.meta.url)).filter(f => f.endsWith('.lum')).map(f => `${d}/${f}`));
  const r = cli('fmt', '--check', ...files);
  assert.equal(r.status, 0, r.stdout);
});

test('std/map.lum: same output on every engine, library warnings stay quiet', () => {
  const expected = ['rose -> 3', 'is -> 2'];
  const outs = ['interp', 'vm', 'c'].map(engine => {
    const r = cli('run', 'examples/std/map_demo.lum', '--engine', engine);
    assert.equal(r.status, 0, `${engine}: ${r.stderr}`);
    assert.equal(r.stderr, '', engine);
    return r.stdout.replace(/\r\n/g, '\n');
  });
  assert.equal(outs[1], outs[0]);
  assert.equal(outs[2], outs[0]);
  for (const line of expected) assert.ok(outs[0].includes(line), line);
  assert.deepEqual(outs[0].trim().split('\n').slice(-7, -2), ['3', 'true', 'true', 'false', '2']);
});

test('std/option.lum and std/math.lum run the same on every engine', () => {
  const outs = ['interp', 'vm', 'c'].map(engine => {
    const r = cli('run', 'examples/std/option_math.lum', '--engine', engine);
    assert.equal(r.status, 0, `${engine}: ${r.stderr}`);
    assert.equal(r.stderr, '', engine);
    return r.stdout.replace(/\r\n/g, '\n');
  });
  assert.equal(outs[1], outs[0]);
  assert.equal(outs[2], outs[0]);
  assert.deepEqual(outs[0].trim().split('\n'), ['5', '-1', 'false', '8', 'false', '12', '12', '1024', '10', 'true', '16', 'false', 'got 3', '-7', '0', '3628800', '910', '19', '5', 'true']);
});

test('std/list.lum higher-order helpers agree on every engine', () => {
  const outs = ['interp', 'vm', 'c'].map(engine => {
    const r = cli('run', 'examples/std/list_demo.lum', '--engine', engine);
    assert.equal(r.status, 0, `${engine}: ${r.stderr}`);
    assert.equal(r.stderr, '', engine);
    return r.stdout.replace(/\r\n/g, '\n');
  });
  assert.equal(outs[1], outs[0]);
  assert.equal(outs[2], outs[0]);
  assert.deepEqual(outs[0].trim().split('\n').slice(2, 4), ['220', '12345678910']);
});

test('std/text.lum helpers agree on every engine', () => {
  const outs = ['interp', 'vm', 'c'].map(engine => {
    const r = cli('run', 'examples/std/text_demo.lum', '--engine', engine);
    assert.equal(r.status, 0, `${engine}: ${r.stderr}`);
    assert.equal(r.stderr, '', engine);
    return r.stdout.replace(/\r\n/g, '\n');
  });
  assert.equal(outs[1], outs[0]);
  assert.equal(outs[2], outs[0]);
  assert.equal(outs[0].split('\n')[0], '[000042]');
});

test('runtime errors list the calling functions on every engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-trace-'));
  try {
    writeFileSync(join(dir, 't.lum'), 'fn inner(xs: int[]): int { return xs[5]; }\nfn outer(xs: int[]): int { return inner(xs) + 1; }\nprint(outer([1]));\n');
    for (const eng of ['vm', 'interp', 'c']) {
    const r = cli('run', join(dir, 't.lum'), '--engine', eng);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('index out of bounds'), r.stderr);
    assert.ok(/in outer \(.*t\.lum:2:/.test(r.stderr), r.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run -e takes code from the command line', () => {
  const r = cli('run', '-e', 'print("x", 1 + 2);');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.replace(/\r\n/g, '\n'), 'x 3\n');
  assert.equal(cli('check', '-e', 'let n: int = "s";').status, 1);
});

test('lumen test runs each test_ function and reports failures', () => {
  const good = cli('test', 'examples/tests/arith.lum');
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.ok(good.stdout.includes('5 passed, 0 failed'), good.stdout);

  const only = cli('test', 'examples/tests/arith.lum', '--only', 'test_pow');
  assert.ok(only.stdout.includes('1 passed, 0 failed'), only.stdout);

  const dir = mkdtempSync(join(tmpdir(), 'lumen-test-'));
  try {
    writeFileSync(join(dir, 't.lum'), 'fn test_a() {\n  assert(1 == 1, "a");\n}\n\nfn test_b() {\n  assert(1 == 2, "b is wrong");\n}\n');
    const r = cli('test', join(dir, 't.lum'), '--engine', 'interp');
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('ok    test_a') && r.stdout.includes('FAIL  test_b: assertion failed: b is wrong (t.lum:6:3)'), r.stdout);
    writeFileSync(join(dir, 'none.lum'), 'print(1);\n');
    assert.equal(cli('test', join(dir, 'none.lum')).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check takes several files and fails if any does', () => {
  const ok = cli('check', 'examples/fib.lum', 'examples/queens.lum');
  assert.equal(ok.status, 0);
  assert.equal((ok.stdout.match(/ok: no issues/g) ?? []).length, 2);
  const dir = mkdtempSync(join(tmpdir(), 'lumen-multi-'));
  try {
    writeFileSync(join(dir, 'bad.lum'), 'let x: int = "s";');
    assert.equal(cli('check', 'examples/fib.lum', join(dir, 'bad.lum')).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lumen test takes several files', () => {
  const r = cli('test', 'examples/tests/arith.lum', 'examples/tests/list.lum', 'examples/tests/maps.lum', 'examples/tests/text.lum');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((r.stdout.match(/\d+ passed, 0 failed/g) ?? []).length, 4);
});

test('the call depth cap is the same on every engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-depth-'));
  try {
    writeFileSync(join(dir, 'd.lum'), 'fn d(n: int): int { return if n == 0 { 0 } else { 1 + d(n - 1) }; }\nprint(d(990));\nprint(d(5000));');
    for (const engine of ['interp', 'vm', 'c']) {
      const r = cli('run', join(dir, 'd.lum'), '--engine', engine);
      assert.equal(r.status, 1, engine);
      assert.equal(r.stdout.replace(/\r\n/g, '\n'), '990\n', engine);
      assert.ok(r.stderr.includes('stack overflow'), engine + r.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('args() sees what follows -- on every engine', () => {
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/io/args.lum', '--engine', engine, '--', 'one', 'two words');
    assert.equal(r.status, 0, engine + r.stderr);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), '2\n0=one\n1=two words\n', engine);
  }
  assert.equal(cli('run', 'examples/io/args.lum').stdout.trim(), '0');
});

test('read_file and write_file agree on every engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-files-'));
  try {
    const target = join(dir, 'note.txt').split(sep).join('/');
    const prog = join(dir, 'f.lum');
    writeFileSync(prog, `write_file("${target}", "one\\ntwo");\nprint(len(read_file("${target}")));\nprint(read_file("${target}/nope"));\n`);
    for (const engine of ['interp', 'vm', 'c']) {
      const r = cli('run', prog, '--engine', engine);
      assert.equal(r.status, 1, engine);
      assert.equal(r.stdout.replace(/\r\n/g, '\n'), '7\n', engine);
      assert.ok(r.stderr.includes('cannot read'), engine + r.stderr);
    }
    assert.equal(readFileSync(join(dir, 'note.txt'), 'utf8'), 'one\ntwo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clock() runs on every engine', () => {
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/io/clock.lum', '--engine', engine);
    assert.equal(r.status, 0, engine + r.stderr);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), '599994\ntrue\n', engine);
  }
});

test('repl commands', () => {
  const r = new Repl();
  assert.equal(r.feed('let x = 3;'), '');
  assert.equal(r.feed(':type x * 2'), 'int\n');
  assert.equal(r.feed(':type [1.5]'), 'float[]\n');
  assert.ok(r.feed(':type nope').startsWith('error[E001]'));
  assert.equal(r.feed('x'), '3\n');
  assert.equal(r.feed(':reset'), 'cleared\n');
  assert.ok(r.feed('x').startsWith('error[E001]'));
});

test('try early return gives the same output on every engine', () => {
  const want = { try_result: 'sum 9\nbad number: x\nbad number: y\n', try_option: '8\nnone\n', try_stmt: '3\nnot positive\n', try_config: '22\nbad value in: b =\n' };
  for (const [name, out] of Object.entries(want)) {
    for (const engine of ['interp', 'vm', 'c']) {
      const r = cli('run', `examples/std/${name}.lum`, '--engine', engine);
      assert.equal(r.stdout.replace(/\r\n/g, '\n'), out, `${name} on ${engine}`);
    }
  }
});

test('user structs as payload of the library Result, same output everywhere', () => {
  const want = 'compile 1 0\nlint 1 0\nbuild 2 1\ntest 3 2\n7\nBUILD,COMPILE,TEST,LINT\nbad priority: x: y\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/std/tasks.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('recursive descent parser built on try agrees on every engine', () => {
  const want = '1 + 2 * 3 = 7\n(1+2)*3 = 9\n2 * -> unexpected end\n4 $ 4 -> bad char $\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/std/expr_parser.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('employees report agrees on every engine', () => {
  const want = 'eng 2 220 ann\nops 2 175 di\nhr 1 70 ed\n2 3\n1 ann 120\n2 bob 100\n3 di 95\n20 5 15 10\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/std/employees.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('labelled loops, closures per iteration and try together agree everywhere', () => {
  const want = '0\n10\n20\nrow 1 col 1\nnone\nnone\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/std/labels_try.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('math and text extras give the same output on every engine', () => {
  const want = '12.5 5.0\n1024.0 0.25\nhello... short\nThe Quick Brown Fox\nمرحب...\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/std/math_text_extra.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('list extras give the same output on every engine', () => {
  const want = '24 1\n[3, 4, 5, 1, 2] [3, 1, 2] [2, 3, 1]\na 2\nb 2\nc 1\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/std/list_extra.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('std/format gives the same output on every engine', () => {
  const want = '1,234,567 -1,000 999 0\n33% 0%\nname   qty\napple  12\nمشمش   7\n\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/std/format_demo.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('std/date gives the same output on every engine', () => {
  const want = '0 11017 -1\n2024-03-01\n0 1 3\nfalse true 28\n1969-12-31\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/std/date_demo.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('std/encoding gives the same output on every engine', () => {
  const want = 'ff 1000 -1a 0\n255 26 -1\n4c756d656e\nTWFu TWE= TQ==\nSGVsbG8sIEx1bWVuIQ==\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/std/encoding_demo.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('const globals, impl methods and nested arrays agree on every engine', () => {
  const want = '10 b\nV { x: 4, y: 6 }\n[1, 2]\n[3, 4]\nx=4, y=$6\n';
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/consts_methods.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, engine);
  }
});

test('local recursive functions that read enclosing locals agree on every engine', () => {
  for (const engine of ['interp', 'vm', 'c']) {
    const r = cli('run', 'examples/local_recursion.lum', '--engine', engine);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), '104 120 2 -1\n', engine);
  }
});
