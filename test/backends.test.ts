import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checked, toC, toBytecode } from '../src/pipeline.ts';
import { RuntimeError } from '../src/diagnostics.ts';
import { ENGINES, runSrc } from './helpers.ts';

const EXAMPLES = new URL('../examples/', import.meta.url);
const runnable = readdirSync(EXAMPLES).filter(f => f.endsWith('.lum') && !['errors.lum', 'lints.lum'].includes(f));

function allEngines(src: string): string {
  const outs = ENGINES.map(([e, o]) => {
    try {
      return runSrc(src, e, o);
    } catch (err) {
      if (err instanceof RuntimeError) return `ERR:${err.message}`;
      throw err;
    }
  });
  for (const o of outs.slice(1)) assert.equal(o, outs[0]);
  return outs[0];
}

test('arithmetic and printing', () => {
  assert.equal(allEngines('print(7 / 2); print(-7 / 2); print(-7 % 3); print(2.0 * 3.5); print(1.0 / 4.0);'), '3\n-3\n-1\n7.0\n0.25\n');
  assert.equal(allEngines('print(0.1 + 0.2); print(1.0 == 1.0);'), '0.30000000000000004\ntrue\n');
});

test('strings and builtins', () => {
  assert.equal(allEngines('print("a" + "b" + str(3) + str(true) + str(1.5)); print(len("héy")); print("x" == "x");'), 'ab3true1.5\n4\ntrue\n');
  assert.equal(allEngines('print(int(-2.7)); print(float(3)); print(str(2.0));'), '-2\n3.0\n2.0\n');
});

test('control flow', () => {
  const src = `
    var s = 0;
    var i = 0;
    while i < 10 {
      i += 1;
      if i == 3 { continue; }
      if i == 8 { break; }
      s += i;
    }
    print(s);
  `;
  assert.equal(allEngines(src), '25\n');
});

test('short-circuit does not evaluate the right side', () => {
  const src = `
    fn boom(): bool { print("boom"); return true; }
    print(false && boom());
    print(true || boom());
    print(true && boom());
  `;
  assert.equal(allEngines(src), 'false\ntrue\nboom\ntrue\n');
});

test('evaluation order is left to right', () => {
  const src = `
    fn t(n: int): int { print(n); return n; }
    print(t(1) - t(2) * t(3));
    fn two(a: int, b: int): int { return a * 10 + b; }
    print(two(t(4), t(5)));
  `;
  assert.equal(allEngines(src), '1\n2\n3\n-5\n4\n5\n45\n');
});

test('globals, locals and recursion', () => {
  const src = `
    var calls = 0;
    fn fact(n: int): int { calls += 1; if n <= 1 { return 1; } return n * fact(n - 1); }
    print(fact(10));
    print(calls);
    fn countdown(n: int) { if n == 0 { return; } countdown(n - 1); }
    countdown(500);
  `;
  assert.equal(allEngines(src), '3628800\n10\n');
});

test('runtime errors agree across engines', () => {
  assert.equal(allEngines('fn z(): int { return 0; } print(1 / z());'), 'ERR:division by zero');
  assert.equal(allEngines('fn z(): int { return 0; } print(1 % z());'), 'ERR:modulo by zero');
  assert.equal(allEngines('fn f(a: int): int { return a * a; } print(f(94906267));'), 'ERR:integer overflow');
  assert.equal(allEngines('fn f(n: int): int { return f(n + 1); } print(f(0));'), 'ERR:stack overflow');
});

test('runtime error carries a source span', () => {
  try {
    runSrc('let a = 1;\nlet b = 0;\nprint(a / b);', 'vm');
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof RuntimeError);
    assert.ok(e.span && e.span.start > 0);
  }
});

test('optimizer folds constants', () => {
  const fe = checked('print(2 * 3 + 4); if 1 > 2 { print(0); }', 't.lum', true);
  const code = toBytecode(fe).main.code.length;
  const plain = toBytecode(checked('print(2 * 3 + 4); if 1 > 2 { print(0); }', 't.lum')).main.code.length;
  assert.ok(code < plain, `${code} should be < ${plain}`);
});

for (const f of runnable) {
  test(`example ${f}: all engines agree`, () => {
    const src = readFileSync(new URL(f, EXAMPLES), 'utf8');
    assert.ok(allEngines(src).length > 0);
  });
}

const cc = ['gcc', 'clang', 'cc'].find(c => !spawnSync(c, ['--version']).error);

test('C backend matches the interpreter', { skip: cc ? false : 'no C compiler on PATH' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-'));
  try {
    for (const f of runnable) {
      const src = readFileSync(new URL(f, EXAMPLES), 'utf8');
      const expected = allEngines(src);
      const cfile = join(dir, f + '.c');
      const exe = join(dir, f + '.exe');
      writeFileSync(cfile, toC(checked(src, f)));
      const build = spawnSync(cc!, ['-O1', '-o', exe, cfile, '-lm'], { encoding: 'utf8' });
      assert.equal(build.status, 0, `${f}: ${build.stderr}`);
      const r = spawnSync(exe, [], { encoding: 'utf8' });
      if (expected.startsWith('ERR:')) {
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(expected.slice(4)), `${f}: ${r.stderr}`);
      } else {
        assert.equal(r.stdout.replace(/\r\n/g, '\n'), expected, f);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
