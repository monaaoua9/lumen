import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { diagCodes } from './helpers.ts';

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
  assert.deepEqual(diagCodes('let a = [[1]]; print(a);'), ['E013']);
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
  assert.ok(diagCodes('for x in 5 { print(x); }').includes('E003'));
  assert.ok(diagCodes('for i in 0..3 { print(1); }').includes('W001'));
  assert.deepEqual(diagCodes('for _ in 0..3 { print(1); }'), []);
  assert.ok(diagCodes('for i in 0..3 { i = 2; }').includes('E005'));
});
