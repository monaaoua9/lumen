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

test('arrays: semantics agree across engines', () => {
  assert.equal(allEngines('let a = [3, 1, 2]; a[1] = 10; push(a, 4); print(a); print(len(a)); print(pop(a)); print(a[0] + a[1]);'), '[3, 10, 2, 4]\n4\n4\n13\n');
  assert.equal(allEngines('let a = [1]; let b = a; b[0] = 9; print(a);'), '[9]\n'); // reference semantics
  assert.equal(allEngines('print([1.5, 2.0]); print(["x"]); print([true, false]);'), '[1.5, 2.0]\n["x"]\n[true, false]\n');
});

test('arrays: runtime errors agree', () => {
  assert.equal(allEngines('let a = [1]; print(a[1]);'), 'ERR:index out of bounds');
  assert.equal(allEngines('let a = [1]; print(a[0 - 1]);'), 'ERR:index out of bounds');
  assert.equal(allEngines('let a: int[] = []; print(pop(a));'), 'ERR:pop from empty array');
  assert.equal(allEngines('fn z(): int { return 0; } let a = [1]; a[5] = 1 / z();'), 'ERR:division by zero');
});

test('arrays: evaluation order with side effects', () => {
  const src = `
    fn t(n: int): int { print(n); return n; }
    let a = [t(1), t(2), t(3)];
    a[t(0)] = t(7);
    print(a[t(1)] + a[t(2)]);
  `;
  assert.equal(allEngines(src), '1\n2\n3\n0\n7\n1\n2\n5\n');
});

test('structs: semantics agree across engines', () => {
  const src = `
    struct P { x: int, y: int }
    struct L { a: P, tag: string }
    let p = P { x: 1, y: 2 };
    let q = p;
    q.x = 10;
    print(p.x);
    let l = L { a: p, tag: "t" };
    l.a.y += 5;
    print(p);
    print(l);
    let ps = [P { x: 1, y: 1 }, P { x: 2, y: 2 }];
    ps[1].x *= 7;
    push(ps, p);
    print(ps);
    print(pop(ps).x + len(ps));
  `;
  assert.equal(allEngines(src), '10\nP { x: 10, y: 7 }\nL { a: P { x: 10, y: 7 }, tag: "t" }\n[P { x: 1, y: 1 }, P { x: 14, y: 2 }, P { x: 10, y: 7 }]\n12\n');
});

test('structs: literal fields run in written order', () => {
  const src = `
    struct P { x: int, y: int }
    fn t(n: int): int { print(n); return n; }
    let p = P { y: t(1), x: t(2) };
    print(p);
  `;
  assert.equal(allEngines(src), '1\n2\nP { x: 2, y: 1 }\n');
});

test('match: semantics agree across engines', () => {
  const src = `
    enum D { N, S }
    fn name(d: D): string { match d { N => { return "north"; } S => { return "south"; } } }
    print(name(D.N) + name(D.S));
    print(D.S);
    var i = 0;
    while i < 6 {
      i += 1;
      match i {
        2 | 4 => { continue; }
        5 => { break; }
        _ => { print(i); }
      }
    }
    match "b" { "a" => { print("A"); } "b" => { print("B"); } _ => { } }
    match -1 { -1 => { print("neg"); } _ => { } }
  `;
  assert.equal(allEngines(src), 'northsouth\nS\n1\n3\nB\nneg\n');
});

test('for loops: continue cannot skip the counter', () => {
  const src = `
    var s = 0;
    for i in 0..6 { if i % 2 == 1 { continue; } s += i; }
    print(s);
    var n = 0;
    for x in [5, 6, 7] { n += x; if x == 6 { break; } }
    print(n);
    for i in 3..3 { print(99); }
  `;
  assert.equal(allEngines(src), '6\n11\n');
});

test('match expressions: arms run lazily, values agree', () => {
  const src = `
    fn t(n: int): int { print(n); return n; }
    let a = match 2 { 1 => t(10), 2 => t(20), _ => t(30) };
    print(a + match true { true => 1, false => 2 });
    print(t(1) + match t(2) { 2 => t(3), _ => 0 });
  `;
  assert.equal(allEngines(src), '20\n21\n1\n2\n3\n4\n');
});

test('enums with data: semantics agree across engines', () => {
  const src = `
    enum T { Leaf(int), Node(T, T) }
    fn total(t: T): int { return match t { Leaf(n) => n, Node(l, r) => total(l) + total(r) }; }
    fn noisy(n: int): int { print(n); return n; }
    let t = T.Node(T.Leaf(noisy(1)), T.Node(T.Leaf(noisy(2)), T.Leaf(noisy(3))));
    print(total(t));
    print(t);
    match t {
      Leaf(_) => { print("leaf"); }
      Node(a, b) => { print(total(a) * 10 + total(b)); }
    }
  `;
  assert.equal(allEngines(src), '1\n2\n3\n6\nNode(Leaf(1), Node(Leaf(2), Leaf(3)))\n15\n');
});
