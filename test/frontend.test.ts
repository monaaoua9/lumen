import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { diagCodes } from './helpers.ts';
import { frontend } from '../src/pipeline.ts';

test('lexer: tokens, comments, escapes', () => {
  const { tokens, diags } = lex('let s = "a\\n\\"b"; // note\n1.5 += x');
  assert.equal(diags.length, 0);
  assert.deepEqual(tokens.map(t => t.kind), ['let', 'ident', '=', 'string', ';', 'float', '+=', 'ident', 'eof']);
  assert.equal(tokens[3].value, 'a\n"b');
});

test('lexer: reports bad input', () => {
  assert.equal(lex('"abc').diags[0].code, 'L001');
  assert.equal(lex('let a = @;').diags[0].code, 'L000');
  assert.equal(lex('99999999999999999999').diags[0].code, 'L003');
});

test('parser: precedence and associativity', () => {
  const { program, diags } = parse('1 + 2 * 3 - 4;');
  assert.equal(diags.length, 0);
  const s = program.body[0];
  assert.equal(s.k, 'expr');
  if (s.k !== 'expr' || s.e.k !== 'binary') throw new Error('shape');
  assert.equal(s.e.op, '-'); // (1 + (2*3)) - 4
  assert.equal(s.e.l.k, 'binary');
});

test('parser: compound assignment desugars', () => {
  const { program } = parse('var x = 1; x *= 3;');
  const s = program.body[1];
  if (s.k !== 'assign' || s.value.k !== 'binary') throw new Error('shape');
  assert.equal(s.value.op, '*');
});

test('parser: recovers and reports several errors', () => {
  const { diags } = parse('let a = ;\nlet b = 2\nlet c = 3;\nfn f( { }');
  assert.ok(diags.length >= 3, `got ${diags.length}`);
  assert.ok(diags.every(d => d.severity === 'error'));
});

test('parser: stray closing brace does not hang', () => {
  const { diags } = parse('} } let x = 1;');
  assert.ok(diags.length >= 1);
});

test('parser: nested functions are rejected', () => {
  assert.ok(parse('fn a() { fn b() {} }').diags.some(d => d.code === 'P002'));
});

test('analyzer: type errors', () => {
  assert.deepEqual(diagCodes('let x: int = "s"; print(x);'), ['E003']);
  assert.deepEqual(diagCodes('print(1 + 1.5);'), ['E003']);
  assert.deepEqual(diagCodes('print("a" + 1);'), ['E003']);
  assert.deepEqual(diagCodes('if 1 { }'), ['E011']);
  assert.deepEqual(diagCodes('print(5 % 2.0);'), ['E003']);
});

test('analyzer: names and calls', () => {
  assert.deepEqual(diagCodes('print(nope);'), ['E001']);
  assert.deepEqual(diagCodes('nope(1);'), ['E002']);
  assert.deepEqual(diagCodes('fn f(a: int): int { return a; } print(f(1, 2));'), ['E004']);
  assert.deepEqual(diagCodes('fn f(a: int): int { return a; } print(f("x"));'), ['E003']);
  assert.deepEqual(diagCodes('fn f() {} fn f() {}').filter(c => c === 'E006'), ['E006']);
  assert.deepEqual(diagCodes('fn print(a: int) {}').includes('E006'), true);
});

test('analyzer: mutability, scopes, control flow', () => {
  assert.ok(diagCodes('let x = 1; x = 2; print(x);').includes('E005'));
  assert.ok(diagCodes('let x = 1; let x = 2; print(x);').includes('E006'));
  assert.ok(diagCodes('break;').includes('E008'));
  assert.ok(diagCodes('return 1;').includes('E009'));
  assert.ok(diagCodes('fn f(): int { if true { return 1; } }').includes('E007'));
  assert.ok(!diagCodes('fn f(): int { if true { return 1; } else { return 2; } } print(f());').includes('E007'));
  assert.ok(!diagCodes('fn f(): int { while true { } } print(f());').includes('E007'));
  assert.ok(diagCodes('fn f(): int { while true { break; } } print(f());').includes('E007'));
  assert.ok(diagCodes('print(1 / 0);').includes('E012'));
});

test('analyzer: void values cannot be used', () => {
  assert.ok(diagCodes('fn f() {} let x = f(); print(x);').includes('E010'));
  assert.ok(diagCodes('print(print(1));').includes('E010'));
});

test('analyzer: lints', () => {
  assert.ok(diagCodes('let a = 1;').includes('W001'));
  assert.ok(!diagCodes('let _a = 1;').includes('W001'));
  assert.ok(diagCodes('fn f(a: int) {} f(1);').includes('W002'));
  assert.ok(diagCodes('let a = 1; { let a = 2; print(a); } print(a);').includes('W003'));
  assert.ok(diagCodes('fn f(): int { return 1; print(2); } print(f());').includes('W004'));
  assert.ok(diagCodes('if true { print(1); }').includes('W004'));
  assert.ok(!diagCodes('var i = 0; while true { i += 1; if i > 3 { break; } }').includes('W004'));
  assert.ok(diagCodes('fn f() {}').includes('W005'));
  assert.ok(diagCodes('let a = 1; print(a == a);').includes('W006'));
  assert.ok(diagCodes('var a = 1; print(a);').includes('W007'));
  assert.ok(diagCodes('1 + 2;').includes('W008'));
});

test('analyzer: a clean program has no diagnostics', () => {
  const src = `
    fn sq(x: int): int { return x * x; }
    var acc = 0;
    var i = 0;
    while i < 5 { acc += sq(i); i += 1; }
    print(acc);
  `;
  assert.deepEqual(diagCodes(src), []);
});

test('analyzer: errors do not cascade', () => {
  // one bad name should give one error, not one per use
  assert.deepEqual(diagCodes('print(zz + 1); print(zz * 2.5);'), ['E001', 'E001']);
});

test('arrays: type checking', () => {
  assert.deepEqual(diagCodes('let a = [1, 2]; print(a[0]);'), []);
  assert.deepEqual(diagCodes('let a = [1, 2.5]; print(a);'), ['E003']);
  assert.deepEqual(diagCodes('let a = []; print(a);'), ['E013']);
  assert.deepEqual(diagCodes('let a: int[] = []; print(a);'), []);
  assert.deepEqual(diagCodes('let a: int[] = [1.5]; print(a);'), ['E003']);
  assert.deepEqual(diagCodes('let a = [1]; print(a["x"]);'), ['E003']);
  assert.deepEqual(diagCodes('let a = 5; print(a[0]);'), ['E003']);
  assert.deepEqual(diagCodes('let a = [1]; a[0] = "s";'), ['E003']);
  assert.deepEqual(diagCodes('let a = [1]; let b = [1]; print(a == b);'), ['E003']);
  assert.deepEqual(diagCodes('let a = [[1]]; print(a);'), []);
  assert.deepEqual(diagCodes('let a = [1]; push(a, 2.0);'), ['E003']);
  assert.deepEqual(diagCodes('let a = [1]; push(a);'), ['E004']);
  assert.deepEqual(diagCodes('fn f(xs: int[]): int { return xs[0]; } print(f([1]));'), []);
  assert.deepEqual(diagCodes('fn f(xs: int[]): int { return xs[0]; } print(f([]));'), []);
});

test('arrays: parser', () => {
  assert.ok(parse('fn f() { let a = [1]; a[f()] += 1; }').diags.length > 0);
  assert.equal(parse('let a = [1, 2]; a[0] += 3;').diags.length, 0);
});

test('arrays: constant negative index is an error', () => {
  assert.ok(diagCodes('let a = [1]; print(a[-1]);').includes('E014'));
  assert.ok(diagCodes('let a = [1]; a[-2] = 0;').includes('E014'));
});

const P = 'struct P { x: int, y: float } ';

test('structs: type checking', () => {
  assert.deepEqual(diagCodes(P + 'let p = P { x: 1, y: 2.0 }; print(p.x); print(p.y);'), []);
  assert.deepEqual(diagCodes(P + 'let p = P { x: 1 }; print(p);'), ['E018']);
  assert.deepEqual(diagCodes(P + 'let p = P { x: 1, y: 2.0, z: 3 }; print(p);'), ['E018']);
  assert.deepEqual(diagCodes(P + 'let p = P { x: 1, x: 2, y: 2.0 }; print(p);'), ['E018']);
  assert.deepEqual(diagCodes(P + 'let p = P { x: 1.5, y: 2.0 }; print(p);'), ['E003']);
  assert.deepEqual(diagCodes(P + 'let p = P { x: 1, y: 2.0 }; print(p.z);'), ['E019']);
  assert.deepEqual(diagCodes('let a = 1; print(a.x);'), ['E019']);
  assert.deepEqual(diagCodes(P + 'let p = P { x: 1, y: 2.0 }; p.x = 2.5;'), ['E003']);
  assert.deepEqual(diagCodes('let p = Q { x: 1 }; print(p);'), ['E016']);
  assert.deepEqual(diagCodes('fn f(a: Nope) {} f(1);').slice(0, 1), ['E016']);
  assert.deepEqual(diagCodes(P + 'let a = P { x: 1, y: 1.0 }; let b = P { x: 1, y: 1.0 }; print(a == b);'), ['E003']);
});

test('structs: declarations', () => {
  assert.ok(diagCodes('struct A { a: A }').includes('E017'));
  assert.ok(diagCodes('struct A { b: B } struct B { a: A }').includes('E017'));
  assert.ok(!diagCodes('struct N { kids: N[] } let n = N { kids: [] }; print(n);').includes('E017'));
  assert.ok(diagCodes('struct A { x: int } struct A { y: int }').includes('E006'));
  assert.ok(diagCodes('struct A { x: int, x: int }').includes('E006'));
  assert.ok(parse('struct A { }').diags.some(d => d.code === 'P003'));
});

test('structs: literal vs block ambiguity', () => {
  // `if ok {` is a condition followed by a block, not a struct literal
  assert.deepEqual(diagCodes('let ok = true; if ok { print(1); } while ok { break; }'), []);
  assert.deepEqual(diagCodes(P + 'if (P { x: 1, y: 1.0 }).x == 1 { print(1); }'), []);
});

const E = 'enum C { R, G, B } ';

test('enums and match: checking', () => {
  assert.deepEqual(diagCodes(E + 'let c = C.R; match c { R => { print(1); } G | B => { print(2); } }'), []);
  assert.deepEqual(diagCodes(E + 'let c = C.R; match c { R => { print(1); } }'), ['E020']);
  assert.deepEqual(diagCodes(E + 'let c = C.R; match c { R => { print(1); } _ => { print(2); } }'), []);
  assert.deepEqual(diagCodes(E + 'let c = C.R; match c { X => { print(1); } _ => { } }'), ['E021']);
  assert.deepEqual(diagCodes(E + 'print(C.X);'), ['E021']);
  assert.deepEqual(diagCodes(E + 'let c = C.R; match c { 1 => { } _ => { } }'), ['E003']);
  assert.deepEqual(diagCodes('match 5 { 1 => { print(1); } }'), ['E020']);
  assert.deepEqual(diagCodes('match true { true => { } false => { } }'), []);
  assert.deepEqual(diagCodes('match 1.5 { _ => { } }'), ['E003']);
  assert.ok(diagCodes(E + 'let c = C.R; match c { R => { } R => { } _ => { } }').includes('W010'));
  assert.ok(diagCodes(E + 'let c = C.R; match c { _ => { } R => { } }').includes('W010'));
  assert.deepEqual(diagCodes(E + 'let a = C.R; let b: C = a; print(a == b); print(a < b);'), ['E003']);
  assert.deepEqual(diagCodes('enum A { X } enum A { Y }').filter(c => c === 'E006'), ['E006']);
  assert.ok(parse('enum A { }').diags.some(d => d.code === 'P003'));
});

test('match: return analysis', () => {
  const f = (body: string) => diagCodes(E + `fn f(c: C): int { ${body} } print(f(C.R));`);
  assert.ok(!f('match c { R => { return 1; } G => { return 2; } B => { return 3; } }').includes('E007'));
  assert.ok(f('match c { R => { return 1; } _ => { } }').includes('E007'));
});

test('for loops: checking', () => {
  assert.deepEqual(diagCodes('for i in 0..3 { print(i); }'), []);
  assert.deepEqual(diagCodes('for x in [1, 2] { print(x); }'), []);
  assert.deepEqual(diagCodes('for i in 0..2.5 { print(i); }'), ['E003']);
  assert.ok(frontend('for i in 0..2.5 { print(i); }').diagnostics[0].message.includes('range bounds'));
  assert.deepEqual(diagCodes('for x in 5 { print(x); }'), ['E003']); // one clear error, no leaked len/index messages
  assert.ok(diagCodes('for i in 0..3 { print(1); }').includes('W001'));
  assert.deepEqual(diagCodes('for _ in 0..3 { print(1); }'), []);
  assert.ok(diagCodes('for i in 0..3 { i = 2; }').includes('E005'));
});

test('match expressions: checking', () => {
  assert.deepEqual(diagCodes(E + 'let c = C.R; print(match c { R => 1, G => 2, B => 3 });'), []);
  assert.deepEqual(diagCodes(E + 'let c = C.R; print(match c { R => 1, G => "x", B => 3 });'), ['E003']);
  assert.deepEqual(diagCodes(E + 'let c = C.R; print(match c { R => 1, G => 2 });'), ['E020']);
  assert.deepEqual(diagCodes('let a: int[] = match 1 { 1 => [], _ => [2] }; print(a);'), []);
  assert.ok(diagCodes('fn f() {} let x = match 1 { 1 => f(), _ => f() }; print(x);').includes('E010'));
});

const D = 'enum S { A(int), B(float, string), U } ';

test('enums with data: checking', () => {
  assert.deepEqual(diagCodes(D + 'let s = S.A(1); match s { A(n) => { print(n); } B(f, t) => { print(t); print(f); } U => { } }'), []);
  assert.deepEqual(diagCodes(D + 'print(S.A("x"));'), ['E003']);
  assert.deepEqual(diagCodes(D + 'print(S.A(1, 2));'), ['E004']);
  assert.deepEqual(diagCodes(D + 'print(S.A);'), ['E022']);
  assert.deepEqual(diagCodes(D + 'print(S.U(1));'), ['E004']);
  assert.deepEqual(diagCodes(D + 'print(S.Q(1));'), ['E021']);
  assert.deepEqual(diagCodes(D + 'match S.U { A(x, y) => { } _ => { } }'), ['E022']);
  assert.deepEqual(diagCodes(D + 'match S.U { A(1) => { } _ => { } }').length > 0, true);
  assert.deepEqual(diagCodes(D + 'match S.U { A(_) | U => { } B(_, _) => { } }'), []);
  assert.deepEqual(diagCodes(D + 'match S.U { A(x) | U => { print(x); } _ => { } }').includes('E022'), true);
  assert.deepEqual(diagCodes(D + 'match S.U { A(n) => { print(n + 1.5); } _ => { } }'), ['E003']);
  assert.deepEqual(diagCodes(D + 'let a = S.U; let b = S.U; print(a == b);'), ['E003']);
  assert.deepEqual(diagCodes('enum T { X(Nope) }'), ['E016']);
  assert.ok(diagCodes('struct P { x: int } print(P.go(1));').includes('E002'));
  assert.ok(diagCodes('let a = 5; print(a.go(1));').includes('E019'));
});

const M = 'struct V { x: int } impl V { fn new(x: int): V { return V { x: x }; } fn get(self): int { return self.x; } fn plus(self, n: int): int { return self.x + n; } } ';

// errors only; unused-function warnings are noise for these snippets
const errs = (src: string) => diagCodes(src).filter(c => c.startsWith('E'));

test('methods: checking', () => {
  assert.deepEqual(errs(M + 'let v = V.new(1); print(v.get()); print(v.plus(2)); print(V.get(v));'), []);
  assert.deepEqual(errs(M + 'let v = V.new(1); print(v.nope());'), ['E019']);
  assert.deepEqual(errs(M + 'let v = V.new(1); print(v.plus());'), ['E004']);
  assert.deepEqual(errs(M + 'let v = V.new(1); print(v.plus("a"));'), ['E003']);
  assert.deepEqual(errs(M + 'print(V.nope(1));'), ['E002']);
  assert.deepEqual(errs(M + 'let n = 5; print(n.get());'), ['E019']);
  assert.deepEqual(errs(M + 'let v = V.new(1); print(v.new(2));'), ['E019']); // `new` has no self
  assert.deepEqual(errs('impl Nope { fn f(self) { } }').includes('E016'), true);
  assert.deepEqual(errs('struct A { x: int } impl A { fn f(self) { } fn f(self) { } }').includes('E006'), true);
});

test('nested arrays: checking', () => {
  assert.deepEqual(diagCodes('let g: int[][] = [[1], []]; print(g[0][0]);'), []);
  assert.deepEqual(diagCodes('let g = [[1], []]; print(g);'), []);
  assert.deepEqual(diagCodes('let g = [[], [1]]; print(g);'), ['E013']);
  assert.deepEqual(diagCodes('let g = [[1], [2.5]]; print(g);'), ['E003']);
  assert.deepEqual(diagCodes('let g = [[1]]; print(g[0][0] + g[0]);'), ['E003']);
  assert.deepEqual(diagCodes('let g = [[1]]; g[0][0] = "s";'), ['E003']);
  assert.deepEqual(diagCodes('let g = [[1]]; g[0] = 5;'), ['E003']);
  assert.deepEqual(diagCodes('let g: int[][] = [[1]]; push(g, [2]); push(g, 3);'), ['E003']);
  assert.deepEqual(diagCodes('fn f(m: Nope[][]) { } f([]);').slice(0, 1), ['E016']);
});

test('function values: checking', () => {
  const F = 'fn inc(x: int): int { return x + 1; } fn ap(f: fn(int): int, x: int): int { return f(x); } ';
  assert.deepEqual(errs(F + 'print(ap(inc, 1)); let g = inc; print(g(2));'), []);
  assert.deepEqual(errs(F + 'print(ap(fn(x: int): int { return x * 2; }, 1));'), []);
  assert.deepEqual(errs(F + 'print(ap(1, 1));'), ['E003']);
  assert.deepEqual(errs(F + 'fn two(a: int, b: int): int { return a; } print(ap(two, 1));'), ['E003']);
  assert.deepEqual(errs(F + 'let g = inc; print(g(1, 2));'), ['E004']);
  assert.deepEqual(errs(F + 'let g = inc; print(g("s"));'), ['E003']);
  assert.deepEqual(errs(F + 'print(inc);'), ['E003']);
  assert.deepEqual(errs(F + 'print(inc == inc);'), ['E003']);
  assert.deepEqual(errs('fn f(g: fn(Nope): int) { } '), ['E016']);
  assert.deepEqual(errs('fn f() { let k = 1; let g = fn(x: int): int { return x + k; }; print(g(1)); } f();'), []);
});

test('function values: calling expressions and fields', () => {
  const F = 'fn inc(x: int): int { return x + 1; } fn get(): fn(int): int { return inc; } struct S { f: fn(int): int, n: int } ';
  assert.deepEqual(errs(F + 'print(get()(1)); let s = S { f: inc, n: 1 }; print(s.f(2));'), []);
  assert.deepEqual(errs(F + 'print(get()("x"));'), ['E003']);
  assert.deepEqual(errs(F + 'print(get()(1, 2));'), ['E004']);
  assert.deepEqual(errs(F + 'let s = S { f: inc, n: 1 }; print(s.n(2));'), ['E019']);
  assert.deepEqual(errs(F + 'print(1(2));'), ['E003']);
});

test('math builtins: checking', () => {
  assert.deepEqual(errs('print(sqrt(2.0) + 1.0); print(abs(-1) + 1); print(abs(-1.5) + 1.0); print(min(1, 2) + 1); print(max(1.0, 2.0) + 1.0);'), []);
  assert.deepEqual(errs('print(sqrt(4));'), ['E003']);
  assert.deepEqual(errs('print(min(1, 2.0));'), ['E003']);
  assert.deepEqual(errs('print(abs("x"));'), ['E003']);
  assert.deepEqual(errs('print(max(1));'), ['E004']);
});

test('closures: capturing', () => {
  const mk = 'fn mk(n: int): fn(int): int { return fn(x: int): int { return x + n; }; } ';
  assert.deepEqual(errs(mk + 'print(mk(1)(2));'), []);
  assert.deepEqual(errs('fn f() { var k = 1; let g = fn(x: int): int { return x + k; }; print(g(1)); k = 2; } f();'), ['E023']);
  assert.deepEqual(errs('fn f() { let k = 1; let g = fn(x: int): int { k = 2; return x; }; print(g(1)); } f();'), ['E005']);
  assert.deepEqual(errs('fn f() { let k = 1; let g = fn(x: int): int { let k = 5; return x + k; }; print(g(1)); } f();').filter(c => c !== 'W003'), []);
  assert.deepEqual(errs('fn f(a: int) { let g = fn(): fn(): int { return fn(): int { return a; }; }; print(g()()); } f(1);'), []);
});

test('function types: arrays of functions', () => {
  const F = 'fn inc(x: int): int { return x + 1; } ';
  assert.deepEqual(errs(F + 'let fs: (fn(int): int)[] = [inc, inc]; print(fs[0](1));'), []);
  assert.deepEqual(errs(F + 'let fs: fn(int): int[] = [inc];'), ['E003']);
});

test('generics: inference and instantiation', () => {
  const G = 'fn first<T>(xs: T[]): T { return xs[0]; } fn pair<A, B>(a: A, b: B): B { return b; } ';
  assert.deepEqual(errs(G + 'print(first([1, 2]) + 1); print(first(["a"]) + "b");'), []);
  assert.deepEqual(errs(G + 'print(first([1]) + "b");'), ['E003']);
  assert.deepEqual(errs(G + 'print(pair(1, 2.5) + 1.0);'), []);
  assert.deepEqual(errs(G + 'print(first(1));'), ['E024']);
  assert.deepEqual(errs(G + 'print(first([1], 2));'), ['E004']);
  assert.deepEqual(errs(G + 'let f = first;'), ['E024']);
  assert.deepEqual(errs('fn mk<T>(): T[] { let e: T[] = []; return e; } let x = mk();'), ['E024']);
  // an error inside the body shows up once per source location, not once per instance
  assert.deepEqual(errs('fn bad<T>(x: T): T { return x + 1; } print(bad(1)); print(bad(2.5));'), ['E003']);
});

test('generic structs: instantiation and inference', () => {
  const B = 'struct Box<T> { value: T } struct Pair<A, B> { a: A, b: B } fn unbox<T>(b: Box<T>): T { return b.value; } ';
  assert.deepEqual(errs(B + 'print(unbox(Box { value: 1 }) + 1);'), []);
  assert.deepEqual(errs(B + 'let b: Box<string> = Box { value: "s" }; print(b.value + "x");'), []);
  assert.deepEqual(errs(B + 'let b: Box<int> = Box { value: "s" };'), ['E003']);
  assert.deepEqual(errs(B + 'let b: Box<int> = Box { value: 1 }; let c: Box<float> = b;'), ['E003']);
  assert.deepEqual(errs(B + 'let p = Pair { a: 1, b: "x" }; print(p.b + "y");'), []);
  assert.deepEqual(errs(B + 'let x: Box<int, int> = Box { value: 1 };'), ['E016']);
  assert.deepEqual(errs(B + 'struct Plain { v: int } let x: Plain<int> = Plain { v: 1 };'), ['E016']);
  assert.deepEqual(errs(B + 'let b = Box { value: [] };'), ['E013']);
  assert.deepEqual(errs('struct Box<T> { value: T } fn f(b: Box<Nope>) { }'), ['E016']);
});

test('traits: impls and bounds', () => {
  const T = 'trait Area { fn area(self): float; fn scale(self, k: float): float; } struct Sq { s: float } struct Ci { r: float } '
    + 'impl Area for Sq { fn area(self): float { return self.s * self.s; } fn scale(self, k: float): float { return self.s * k; } } '
    + 'fn show<T: Area>(x: T): float { return x.area(); } ';
  assert.deepEqual(errs(T + 'print(show(Sq { s: 2.0 }));'), []);
  assert.deepEqual(errs(T + 'print(show(Ci { r: 1.0 }));'), ['E025']);
  assert.deepEqual(errs(T + 'print(show(3));'), ['E025']);
  assert.deepEqual(errs(T + 'impl Area for Ci { fn area(self): float { return 1.0; } }'), ['E026']);
  assert.deepEqual(errs(T + 'impl Area for Ci { fn area(self): int { return 1; } fn scale(self, k: float): float { return k; } }'), ['E026']);
  assert.deepEqual(errs(T + 'impl Nope for Ci { }'), ['E025']);
  assert.deepEqual(errs(T + 'impl Area for Missing { }'), ['E016']);
  assert.deepEqual(errs('fn f<T: Nope>(x: T) { }'), ['E025']);
  assert.deepEqual(errs('trait A { fn f(self); } trait A { fn g(self); }'), ['E006']);
});

test('generic enums: instantiation and inference', () => {
  const O = 'enum Opt<T> { Some(T), None } fn get<T>(o: Opt<T>, d: T): T { match o { Some(v) => { return v; } None => { return d; } } } ';
  assert.deepEqual(errs(O + 'print(get(Opt.Some(1), 2) + 1); let n: Opt<string> = Opt.None; print(get(n, "x") + "y");'), []);
  assert.deepEqual(errs(O + 'let n = Opt.None;'), ['E024']);
  assert.deepEqual(errs(O + 'let n: Opt<int> = Opt.Some("s");'), ['E003']);
  assert.deepEqual(errs(O + 'let n: Opt<int> = Opt.Some(1); let m: Opt<float> = n;'), ['E003']);
  assert.deepEqual(errs(O + 'let n = Opt.Nope(1);'), ['E021']);
  assert.deepEqual(errs(O + 'let n: Opt<int, int> = Opt.None;'), ['E016']);
  assert.deepEqual(errs(O + 'let n: Opt<int> = Opt.Some(1); match n { Some(v) => { print(v); } }'), ['E020']);
});

test('generic impl blocks', () => {
  const S = 'struct Box<T> { v: T } impl<T> Box<T> { fn new(x: T): Box<T> { return Box { v: x }; } fn get(self): T { return self.v; } fn put(self, x: T) { self.v = x; } } ';
  assert.deepEqual(errs(S + 'let b = Box.new(1); b.put(2); print(b.get() + 1);'), []);
  assert.deepEqual(errs(S + 'let b = Box.new("s"); print(b.get() + 1);'), ['E003']);
  assert.deepEqual(errs(S + 'let b = Box.new(1); b.put("s");'), ['E003']);
  assert.deepEqual(errs(S + 'let b = Box.new(1); b.nope();'), ['E019']);
  assert.deepEqual(errs(S + 'let b = Box.new(1); print(b.get(5));'), ['E004']);
});
