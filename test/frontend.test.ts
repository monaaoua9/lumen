import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { diagCodes, runSrc } from './helpers.ts';
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

test('parser: nested structs and impls are rejected', () => {
  assert.ok(parse('fn a() { struct S { x: int } }').diags.some(d => d.code === 'P002'));
  assert.ok(parse('fn a() { impl S { } }').diags.some(d => d.code === 'P002'));
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
  assert.deepEqual(diagCodes(P + 'let a = P { x: 1, y: 1.0 }; let b = P { x: 1, y: 1.0 }; print(a == b);'), []);
  assert.deepEqual(diagCodes('struct B { v: int[] } let a = B { v: [1] }; let b = B { v: [1] }; print(a == b);'), ['E003']);
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
  assert.deepEqual(errs('print(floor(1.5) + ceil(1.5));'), []);
  assert.deepEqual(errs('print(floor(1));'), ['E003']);
  assert.deepEqual(errs('print(min(1, 2.0));'), ['E003']);
  assert.deepEqual(errs('print(abs("x"));'), ['E003']);
  assert.deepEqual(errs('print(max(1));'), ['E004']);
});

test('string builtins: checking', () => {
  assert.deepEqual(errs('let a: string[] = split("a,b", ","); print(substr("abc", 1, 1) + str(find("abc", "c")) + str(len(a)));'), []);
  assert.deepEqual(errs('print(substr(1, 0, 1));'), ['E003']);
  assert.deepEqual(errs('print(substr("abc", 0.5, 1));'), ['E003']);
  assert.deepEqual(errs('print(find("abc", 1));'), ['E003']);
  assert.deepEqual(errs('print(split("abc"));'), ['E004']);
  assert.deepEqual(errs('print(chr(byte("a", 0)));'), []);
  assert.deepEqual(errs('print(chr("a"));'), ['E003']);
  assert.deepEqual(errs('print(join(split("a b", " "), "-") + trim(" x "));'), []);
  assert.deepEqual(errs('print(join([1, 2], ","));'), ['E003']);
  assert.deepEqual(errs('print(trim(1));'), ['E003']);
  assert.deepEqual(errs('print(upper("a") + lower("B") + repeat("x", 2) + replace("a", "b", "c")); print(starts_with("a", "b") && ends_with("a", "b"));'), []);
  assert.deepEqual(errs('print(repeat(1, 2));'), ['E003']);
  assert.deepEqual(errs('print(parse_int("4", 0) + 1); print(parse_float("4", 0.5) + 1.0);'), []);
  assert.deepEqual(errs('print(parse_int("4", 0.5));'), ['E003']);
  assert.deepEqual(errs('print(parse_float(4, 0.5));'), ['E003']);
  assert.deepEqual(errs('print(replace("a", "b"));'), ['E004']);
  assert.deepEqual(errs('print(starts_with("a", 1));'), ['E003']);
  assert.deepEqual(errs('print(byte("a", "0"));'), ['E003']);
});

test('strings: ordering', () => {
  assert.deepEqual(errs('print("a" < "b"); print("a" >= "a");'), []);
  assert.deepEqual(errs('print("a" < 1);'), ['E003']);
  assert.deepEqual(errs('print(true < false);'), ['E003']);
});

test('if expressions', () => {
  assert.deepEqual(errs('print(if 1 < 2 { "a" } else if true { "b" } else { "c" });'), []);
  assert.deepEqual(errs('print(if 1 { 1 } else { 2 });'), ['E003']);
  assert.deepEqual(errs('print(if true { 1 } else { "a" });'), ['E003']);
  assert.deepEqual(diagCodes('print(if true { 1 });'), ['P001']);
});

test('assert builtin', () => {
  assert.deepEqual(errs('assert(1 < 2, "math");'), []);
  assert.deepEqual(errs('assert(1, "math");'), ['E003']);
  assert.deepEqual(errs('assert(true);'), []);
  assert.deepEqual(errs('assert(1);'), ['E003']);
  assert.deepEqual(errs('assert(true, "a", "b");'), ['E004']);
  assert.deepEqual(errs('print(assert(true, "x"));'), ['E010']);
});

test('stdin builtins: checking', () => {
  assert.deepEqual(errs('while !at_eof() { print(read_line() + "!"); }'), []);
  assert.deepEqual(errs('print(read_line(1));'), ['E004']);
  assert.deepEqual(errs('let n: int = read_line();'), ['E003']);
});

test('string interpolation', () => {
  assert.deepEqual(errs('let n = 1; print("n = {n}, next {n + 1}, \\{raw\\}");'), []);
  assert.deepEqual(errs('print("{nope}");'), ['E001']);
  assert.deepEqual(errs('let a = [1]; print("{a[0] + "x"}");'), ['E003']);
  assert.deepEqual(diagCodes('print("{");').slice(0, 2), ['L004', 'L001']);
  assert.deepEqual(diagCodes('print("{}");'), ['L004']);
});

test('exit builtin', () => {
  assert.deepEqual(errs('exit(2);'), []);
  assert.deepEqual(errs('exit("x");'), ['E003']);
  assert.deepEqual(errs('exit();'), ['E004']);
});

test('array builtins: checking', () => {
  assert.deepEqual(errs('let a = [3, 1]; sort(a); reverse(a); print(slice(a, 0, 1)); print(contains(a, 1));'), []);
  assert.deepEqual(errs('let s = [[1]]; reverse(s); print(slice(s, 0, 1));'), []);
  assert.deepEqual(errs('sort([[1]]);'), ['E003']);
  assert.deepEqual(errs('let a = [1]; insert(a, 0, 2); print(remove(a, 0)); remove(a, 0);'), []);
  assert.deepEqual(errs('let a = [1]; insert(a, 0, "x");'), ['E003']);
  assert.deepEqual(errs('let a = [1]; print(remove(a, "0"));'), ['E003']);
  assert.deepEqual(errs('print(contains([1], "x"));'), ['E003']);
  assert.deepEqual(errs('print(slice(1, 0, 1));'), ['E003']);
  assert.deepEqual(errs('let a: int[] = slice(["a"], 0, 1);'), ['E003']);
});

test('lint: unused builtin results', () => {
  assert.deepEqual(diagCodes('abs(3);'), ['W008']);
  assert.deepEqual(diagCodes('let a = [2, 1]; sort(a); push(a, 3); print(a);'), []);
});

test('for ... step', () => {
  assert.deepEqual(errs('for i in 0..10 step 3 { print(i); }'), []);
  assert.deepEqual(diagCodes('for i in 0..10 step 0 { print(i); }'), ['P001']);
  assert.deepEqual(diagCodes('for i in 0..10 step -1 { print(i); }').includes('P001'), true);
});

test('lexer: number forms and block comments', () => {
  const nums = (src: string) => lex(src).tokens.filter(t => t.kind === 'int' || t.kind === 'float').map(t => t.value);
  assert.deepEqual(nums('0xFF 0b101 1_000 0x7f_ff 2_5.5_5'), [255, 5, 1000, 32767, 25.55]);
  assert.deepEqual(diagCodes('print(1 /* two */ + 2);'), []);
  assert.deepEqual(diagCodes('/* open'), ['L005']);
  assert.deepEqual(diagCodes('print(0x);'), ['L003']);
});

test('local functions', () => {
  assert.deepEqual(errs('fn f(k: int): int { fn g(x: int): int { return x * k; } return g(2); } print(f(3));'), []);
  assert.deepEqual(errs('fn f(): int { fn g(k: int): int { return if k == 0 { 0 } else { g(k - 1) }; } return g(3); } print(f());'), []);
  // a recursive one is a real function, so it cannot see the enclosing locals
  assert.deepEqual(errs('fn f(): int { let b = 1; fn g(k: int): int { return if k == 0 { b } else { g(k - 1) }; } return g(3); } print(f());'), ['E001']);
});

test('syntax: trailing commas and field shorthand', () => {
  const S = 'struct P { x: int, y: int } ';
  assert.deepEqual(errs(S + 'fn mk(a: int,): P { return P { x: a, y: 2, }; } print(mk(1,)); print([1, 2,]);'), []);
  assert.deepEqual(errs(S + 'let x = 1; let y = 2; print(P { x, y }); print(P { x, y: 3 });'), []);
  assert.deepEqual(errs(S + 'let x = 1; print(P { x, y });'), ['E001']);
});

test('constants flow through immutable lets', () => {
  assert.deepEqual(diagCodes('let d = 0; print(1 / d);'), ['E012']);
  assert.deepEqual(diagCodes('let z = -0; print(1 % z);'), ['E012']);
  assert.deepEqual(diagCodes('let a = [1]; let i = -1; print(a[i]);'), ['E014']);
  assert.deepEqual(diagCodes('var d = 0; d += 1; print(1 / d);'), []);
  assert.deepEqual(diagCodes('let d = 2; print(1 / d);'), []);
});

test('match guards', () => {
  const E = 'enum E { A(int), B } ';
  assert.deepEqual(errs(E + 'let e = E.A(1); print(match e { A(n) if n > 0 => 1, A(_) => 2, B => 3 });'), []);
  assert.deepEqual(errs(E + 'let e = E.B; print(match e { A(n) if n > 0 => 1, B => 3 });'), ['E020']);
  assert.deepEqual(errs(E + 'let e = E.B; print(match e { A(n) if n => 1, _ => 3 });'), ['E011']);
  assert.deepEqual(errs('let n = 1; match n { _ if n > 0 => { print(1); } }'), ['E020']);
  assert.deepEqual(diagCodes('let n = 1; match n { 1 if n > 0 => { print(1); } 1 => { print(2); } _ => { } }'), []);
});

test('block expressions', () => {
  assert.deepEqual(errs('let a = { let x = 1; x + 1 }; print(a);'), []);
  assert.deepEqual(errs('let a: int = { 1 }; print(a);'), []);
  assert.deepEqual(errs('let a = { let x = 1; x }; print(x);'), ['E001']);
  assert.deepEqual(errs('fn f(): int { let a = { return 1; 2 }; return a; } print(f());'), ['E029']);
  assert.deepEqual(errs('while true { let a = { break; 1 }; print(a); }'), ['E008']);
  assert.deepEqual(errs('let a = { let x = 1; x }; let b: string = a; print(b);'), ['E003']);
  assert.deepEqual(diagCodes('let a = { let x = 1; };'), ['P001']);
  assert.deepEqual(errs('print(match 1 { 1 => { let a = 2; a } _ => 0 });'), []);
});

test('generics: type parameters from the expected result type', () => {
  const G = 'struct Box<T> { items: T[] } fn empty<T>(): Box<T> { return Box { items: [] }; } ';
  assert.deepEqual(errs(G + 'let b: Box<int> = empty(); push(b.items, 1); print(b);'), []);
  assert.deepEqual(errs(G + 'let b = empty(); print(b);'), ['E024']);
  assert.deepEqual(errs(G + 'let b: Box<int> = empty(); let c: Box<string> = b; print(c);'), ['E003']);
});

test('lambda parameter inference', () => {
  assert.deepEqual(errs('fn ap(f: fn(int): int, x: int): int { return f(x); } print(ap(fn(v) => v + 1, 2));'), []);
  assert.deepEqual(errs('fn ap(f: fn(int): int, x: int): int { return f(x); } print(ap(fn(v) { return v * 2; }, 2));'), []);
  assert.deepEqual(errs('let f = fn(x) => x + 1;'), ['E030']);
  assert.deepEqual(errs('fn ap(f: fn(int): int, x: int): int { return f(x); } print(ap(fn(v) => "s", 2));'), ['E003']);
});

test('for with an index variable', () => {
  assert.deepEqual(errs('for i, x in [1, 2] { print(i + x); }'), []);
  assert.deepEqual(diagCodes('for i, x in 0..3 { print(x); }'), ['P001']);
});

test('array slice syntax', () => {
  assert.deepEqual(errs('let a = [1, 2, 3]; let b: int[] = a[0..2]; print(b);'), []);
  assert.deepEqual(errs('let s: string = "abc"[0..1]; print(s);'), []);
  assert.deepEqual(errs('print(slice(1, 0, 1));'), ['E003']);
});

test('if let', () => {
  const E = 'enum O { Some(int), None } ';
  assert.deepEqual(errs(E + 'let o = O.Some(1); if let Some(v) = o { print(v); } else { print(0); }'), []);
  assert.deepEqual(errs(E + 'let o = O.None; if let Nope(v) = o { print(v); }'), ['E021', 'E001']);
});

test('indexing a string', () => {
  assert.deepEqual(errs('let c: string = "abc"[1]; print(c);'), []);
  assert.deepEqual(errs('var s = "abc"; s[0] = "x";'), ['E003']);
});

test('destructuring lets', () => {
  assert.deepEqual(errs('let [a, b] = [1, 2]; print(a + b);'), []);
  assert.deepEqual(errs('struct P { x: int } let P { x } = P { x: 1 }; print(x);'), []);
  assert.deepEqual(errs('let [a, b] = 5; print(a);'), ['E003']);
  assert.deepEqual(errs('struct P { x: int } let P { z } = P { x: 1 }; print(z);'), ['E019']);
});

test('struct update syntax', () => {
  const S = 'struct P { x: int, y: int } struct Q { z: int } let a = P { x: 1, y: 2 }; ';
  assert.deepEqual(errs(S + 'let b = P { x: 5, ..a }; print(b);'), []);
  assert.deepEqual(errs(S + 'let b = P { ..P { x: 1, y: 2 } };'), ['E018', 'E018']);
  assert.deepEqual(errs(S + 'let c = Q { z: 1 }; let b = P { x: 5, ..c };'), ['E003', 'E019']);
});

test('default arguments', () => {
  const F = 'fn f(a: int, b: int = 2): int { return a + b; } ';
  assert.deepEqual(errs(F + 'print(f(1)); print(f(1, 5));'), []);
  assert.deepEqual(errs(F + 'print(f());'), ['E004']);
  assert.deepEqual(errs(F + 'print(f(1, 2, 3));'), ['E004']);
  assert.deepEqual(errs('fn g(a: int = "s"): int { return a; } print(g());'), ['E003']);
  assert.deepEqual(diagCodes('fn h(a: int = 1, b: int): int { return a + b; }'), ['P001']);
});

test('range patterns', () => {
  assert.deepEqual(errs('let n = 5; print(match n { 0..3 => 1, 3..=9 => 2, _ => 0 });'), []);
  assert.deepEqual(errs('let n = 5; print(match n { 0..3 => 1 });'), ['E020']);
  assert.deepEqual(diagCodes('let n = 5; print(match n + 1 { 0..3 => 1, _ => 0 });'), ['P001']);
});

test('tuple patterns', () => {
  assert.deepEqual(errs('let t = (1, "a"); print(match t { (1, "a") => 1, (_, _) => 2, _ => 3 });'), []);
  assert.deepEqual(errs('let n = 4; print(match (n % 2, n) { (0, 4) => 1, _ => 0 });'), []);
  assert.deepEqual(errs('let n = 4; print(match (n % 2, n) { (0, 4) => 1 });'), ['E020']);
  assert.ok(diagCodes('fn f(): int { return 1; } print(match (f(), 2) { (1, 2) => 1, _ => 0 });').includes('P001'));
  assert.ok(diagCodes('let n = 1; print(match (n, n) { (1, 2, 3) => 1, _ => 0 });').includes('P001'));
  assert.ok(diagCodes('let n = 1; print(match (n, n) { (Some(1), 2) => 1, _ => 0 });').includes('P001'));
});

test('tuple patterns bind names', () => {
  assert.deepEqual(errs('let t = (1, 2); print(match t { (0, y) => y, (x, _) => x });'), []);
  assert.deepEqual(errs('let t = (1, 2); print(match t { (x, y) => x + y });'), []);
  assert.ok(diagCodes('let t = (1, 2); print(match t { (0, 1) | (x, _) => 1, _ => 2 });').includes('P001'));
});

test('print takes several values', () => {
  assert.deepEqual(errs('print("a", 1, 2.5, [1]);'), []);
  assert.equal(runSrc('print("a", 1, true);', 'vm'), 'a 1 true\n');
});

test('named arguments', () => {
  const F = 'fn f(a: int, b: int = 2): int { return a - b; } ';
  assert.deepEqual(errs(F + 'print(f(b: 1, a: 5)); print(f(1, b: 3)); print(f(a: 4));'), []);
  assert.deepEqual(errs(F + 'print(f(c: 1, a: 5));'), ['E004']);
  assert.deepEqual(errs(F + 'print(f(a: 1, a: 2));'), ['E004']);
  assert.deepEqual(errs(F + 'print(f(b: 1));'), ['E004']);
  assert.deepEqual(errs(F + 'print(f(a: 1, 2));'), ['E004']);
  assert.deepEqual(errs('print(len(xs: [1]));'), ['E004']);
});

test('multiple assignment', () => {
  assert.deepEqual(errs('var a = 1; var b = 2; a, b = b, a; print(a + b);'), []);
  assert.deepEqual(diagCodes('var a = 1; var b = 2; a, b = 1; print(a + b);'), ['P001']);
  assert.deepEqual(errs('var a = 1; a, b = 1, 2;'), ['E001']);
});

test('unicode and hex escapes', () => {
  assert.deepEqual(diagCodes('print("\\u{1F600}\\x41");'), []);
  assert.deepEqual(diagCodes('print("\\xff");'), ['L002']);
  assert.deepEqual(diagCodes('print("\\u{D800}");'), ['L002']);
  assert.deepEqual(diagCodes('print("\\u{110000}");'), ['L002']);
  assert.equal(runSrc('print(len("\\u{627}") + len("\\x41"));', 'vm'), '3\n');
});

test('loop statement', () => {
  assert.deepEqual(errs('var i = 0; loop { i += 1; if i > 2 { break; } } print(i);'), []);
  assert.deepEqual(errs('var loop = 1; loop = loop + 1; print(loop);'), []);
});

test('tuples', () => {
  assert.deepEqual(errs('let t = (1, "a"); print(t.0 + 1); print(t.1);'), []);
  assert.deepEqual(errs('fn f(): (int, bool) { return (1, true); } let (a, b) = f(); print(a); print(b);'), []);
  assert.deepEqual(errs('let t = (1, 2); print(t.5);'), ['E019']);
  assert.deepEqual(errs('let t: (int, int) = (1, "x");'), ['E003']);
  assert.deepEqual(errs('print((1, 2) == (1, 2));'), []);
});

test('closures: capturing', () => {
  const mk = 'fn mk(n: int): fn(int): int { return fn(x: int): int { return x + n; }; } ';
  assert.deepEqual(errs(mk + 'print(mk(1)(2));'), []);
  assert.deepEqual(errs('fn f() { var k = 1; let g = fn(x: int): int { k += x; return k; }; print(g(1)); k = 2; print(k); } f();'), []);
  assert.deepEqual(errs('fn f() { var k = 1; let g = fn(): int { k = "s"; return 1; }; print(g()); } f();'), ['E003']);
  assert.deepEqual(errs('fn f() { var k = 1; let g = fn(): fn(): int { return fn(): int { k += 1; return k; }; }; print(g()()); } f();'), []);
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

test('traits: default methods', () => {
  const T = 'trait Named { fn name(self): string; fn hello(self): string { return "hi " + self.name(); } } struct A { n: string } struct B { n: string } '
    + 'impl Named for A { fn name(self): string { return self.n; } } '
    + 'impl Named for B { fn name(self): string { return self.n; } fn hello(self): string { return "yo"; } } ';
  assert.deepEqual(errs(T + 'print(A { n: "x" }.hello() + B { n: "y" }.hello());'), []);
  assert.deepEqual(errs(T + 'struct C { n: string } impl Named for C { }'), ['E026']);
  assert.deepEqual(errs('trait T { fn f(self): int { return self.nope(); } } struct S { v: int } impl T for S { }'), ['E019']);
});

test('traits: dyn (dynamic dispatch)', () => {
  const T = 'trait Area { fn area(self): float; fn scale(self, k: float): float; } struct Sq { s: float } struct Ci { r: float } struct No { v: int } '
    + 'impl Area for Sq { fn area(self): float { return self.s; } fn scale(self, k: float): float { return self.s * k; } } '
    + 'impl Area for Ci { fn area(self): float { return self.r; } fn scale(self, k: float): float { return self.r * k; } } ';
  assert.deepEqual(errs(T + 'let xs: dyn Area[] = [Area.from(Sq { s: 1.0 }), Area.from(Ci { r: 2.0 })]; print(xs[0].area() + xs[1].scale(2.0));'), []);
  assert.deepEqual(errs(T + 'let x = Area.from(No { v: 1 });'), ['E025']);
  assert.deepEqual(errs(T + 'let x: dyn Area = Area.from(Sq { s: 1.0 }); print(x.scale(1));'), ['E003']);
  assert.deepEqual(errs(T + 'fn f<T: Area>(x: T): float { return x.area(); } print(f(Area.from(Sq { s: 1.0 })));'), []);
  assert.deepEqual(errs('trait E { fn f(self); } let x: dyn E = 1;'), ['E016', 'E003']);
});

test('traits: implicit coercion to dyn', () => {
  const T = 'trait A { fn f(self): int; } struct X { v: int } struct Y { v: int } impl A for X { fn f(self): int { return 1; } } ';
  assert.deepEqual(errs(T + 'fn g(a: dyn A): int { return a.f(); } print(g(X { v: 1 })); let a: dyn A = X { v: 2 }; fn h(): dyn A { return X { v: 3 }; }'), []);
  assert.deepEqual(errs(T + 'fn g(a: dyn A): int { return a.f(); } print(g(Y { v: 1 }));'), ['E003']);
});

test('generic impl blocks: trait bounds', () => {
  const S = 'trait Area { fn area(self): float; } struct Sq { s: float } struct No { v: int } impl Area for Sq { fn area(self): float { return self.s; } } '
    + 'struct Holder<T> { item: T } impl<T: Area> Holder<T> { fn total(self): float { return self.item.area(); } } ';
  assert.deepEqual(errs(S + 'let h = Holder { item: Sq { s: 2.0 } }; print(h.total());'), []);
  assert.deepEqual(errs(S + 'let h = Holder { item: No { v: 1 } }; print(h.total());'), ['E025']);
});

test('impls for instances of generic types', () => {
  const S = 'trait Show { fn show(self): string; } struct Box<T> { v: T } impl Show for Box<int> { fn show(self): string { return str(self.v); } } fn sh<T: Show>(x: T): string { return x.show(); } ';
  assert.deepEqual(errs(S + 'print(sh(Box { v: 1 }));'), []);
  assert.deepEqual(errs(S + 'print(sh(Box { v: "s" }));'), ['E025']);
  assert.deepEqual(errs(S + 'impl Show for Box<float> { }'), ['E026']);
  assert.deepEqual(errs(S + 'impl Box<int> { fn twice(self): int { return self.v * 2; } } print(Box { v: 2 }.twice());'), []);
});

test('lint: generic function never instantiated', () => {
  assert.deepEqual(diagCodes('fn id<T>(x: T): T { return x + x + nope; }'), ['W011']);
  assert.deepEqual(diagCodes('fn id<T>(x: T): T { return x; } print(id(1));'), []);
});
