interface Entry {
  title: string;
  text: string;
  bad?: string;
  fix?: string;
}

export const EXPLAIN: Record<string, Entry> = {
  L000: { title: 'unexpected character', text: 'The lexer met a character that is not part of the language.', bad: 'let x = 3 # 4;' },
  L001: { title: 'unterminated string literal', text: 'A string started with a quote and the line ended before the closing quote.', bad: 'print("hello);', fix: 'print("hello");' },
  L002: { title: 'unknown escape sequence', text: 'Supported escapes are \\n \\t \\r \\0 \\\\ \\" \\{ and \\}.', bad: 'print("a\\q");' },
  L003: { title: 'bad number literal', text: 'Integers are limited to 2^53 - 1 so that every backend agrees on their value, and 0x / 0b literals need digits.' },
  L004: { title: 'bad interpolation', text: 'A "{" inside a string opens an interpolation and needs a matching "}" with an expression between. Use \\{ for a literal brace.', bad: 'print("{}");', fix: 'print("{n}");' },
  L005: { title: 'unterminated block comment', text: 'A /* comment was opened and the file ended before the closing */.', bad: '/* TODO' },

  P001: { title: 'syntax error', text: 'The parser expected something else at this point. The message names what it found.', bad: 'let = 5;', fix: 'let x = 5;' },
  P002: { title: 'declaration in the wrong place', text: 'struct, enum, trait and impl declarations can only appear at the top level of a file. A named fn inside a body is a local function; at the top level it is an ordinary one.' },
  P003: { title: 'empty enum', text: 'An enum needs at least one variant.', bad: 'enum Nothing { }' },
  P004: { title: 'cannot import file', text: 'The file named in an import line does not exist or cannot be read. Paths are relative to the importing file.', bad: 'import "nope.lum";' },
  P005: { title: 'pub on the wrong item', text: 'pub applies to fn, struct, enum and trait declarations.', bad: 'pub let x = 1;' },
  P006: { title: 'ambiguous name', text: 'Several imported files declare this name and the current file does not. Qualify it with the module.', bad: 'print(area(s));', fix: 'print(shapes.area(s));' },

  E001: { title: 'unknown variable', text: 'The name is not declared in any enclosing scope. A close match is suggested when there is one.', bad: 'print(totl);', fix: 'let total = 1; print(total);' },
  E002: { title: 'not a function', text: 'A variable that does not hold a function value was called.', bad: 'let x = 1; x(2);' },
  E003: { title: 'type mismatch', text: 'A value has a different type than the context needs. int and float never convert implicitly; use int(x), float(x) or str(x).', bad: 'let n: int = "a";', fix: 'let n: int = 1;' },
  E004: { title: 'wrong number of arguments', text: 'A call, constructor or builtin received more or fewer arguments than it declares.', bad: 'max(1);', fix: 'max(1, 2);' },
  E005: { title: 'assignment to an immutable name', text: 'let bindings cannot be reassigned. Declare the name with var when it must change.', bad: 'let n = 1; n = 2;', fix: 'var n = 1; n = 2;' },
  E006: { title: 'name already declared', text: 'The name is taken in this scope, or it is a builtin that cannot be redefined.', bad: 'let a = 1; let a = 2;' },
  E007: { title: 'missing return', text: 'A function with a return type has a path that ends without returning.', bad: 'fn f(x: int): int { if x > 0 { return 1; } }', fix: 'add a return at the end' },
  E008: { title: 'break or continue outside a loop', text: 'break and continue only make sense inside while and for.' },
  E009: { title: 'return outside a function', text: 'The top level of a file is not a function body.' },
  E010: { title: 'void used as a value', text: 'A function without a return type produces no value to store or print.', bad: 'let r = print(1);' },
  E011: { title: 'condition is not bool', text: 'if, while and && need a bool. Compare explicitly instead of relying on truthiness.', bad: 'if n { }', fix: 'if n != 0 { }' },
  E012: { title: 'constant division by zero', text: 'The divisor is the literal 0, or a let that was initialised with it, so the program would always fail.', bad: 'let d = 0; print(1 / d);' },
  E013: { title: 'cannot infer array type', text: 'An empty array literal has no element to take a type from. Annotate the target.', bad: 'let xs = [];', fix: 'let xs: int[] = [];' },
  E014: { title: 'negative constant index', text: 'The index is a negative literal, or a let that was initialised with one, so the access would always fail.', bad: 'print(xs[-1]);' },
  E016: { title: 'unknown type', text: 'A struct or enum name was used that is not declared, or type arguments were given to a type that is not generic.' },
  E017: { title: 'struct contains itself', text: 'A struct field of its own type would have infinite size. Use an array field to break the cycle.', bad: 'struct Node { next: Node }', fix: 'struct Node { next: Node[] }' },
  E018: { title: 'unknown struct field', text: 'The literal names a field the struct does not have.' },
  E019: { title: 'bad field or method access', text: 'The value has no such field or method, or it is not a struct or enum at all.' },
  E020: { title: 'non-exhaustive match', text: 'Some enum variants, or the rest of an int or string, are not covered. Add the missing arms or a _ arm.' },
  E021: { title: 'unknown enum variant', text: 'The enum has no variant with that name.' },
  E022: { title: 'variant needs arguments', text: 'A variant that carries data must be written with its values.', bad: 'Shape.Circle', fix: 'Shape.Circle(1.0)' },
  E023: { title: 'internal closure capture', text: 'A closure could not capture this variable. Copy it into a let first.' },
  E024: { title: 'cannot infer type parameter', text: 'A generic call or constructor does not mention the type parameter anywhere the compiler can see. Annotate the result.' },
  E025: { title: 'trait not implemented', text: 'A bound or dyn coercion needs an impl that does not exist, or the trait itself is unknown.' },
  E026: { title: 'impl does not match its trait', text: 'An impl block lacks a method the trait declares, or the signature differs.' },
  E027: { title: 'private item', text: 'Only items declared pub can be used from another file.', fix: 'pub fn helper() { }' },
  E029: { title: 'control flow out of a block expression', text: 'A block expression produces a value, so return cannot leave it. break and continue may only target loops written inside the block.', bad: 'let x = { return 1; 2 };' },
  E030: { title: 'cannot infer a parameter type', text: 'A function value may leave its parameter types out only where the expected type is known, for example as an argument of a function that takes <fn(int):int>.', bad: 'let f = fn(x) => x + 1;' },
  E031: { title: 'recursive local function in a generic function', text: 'A local function that calls itself becomes one shared top-level function, so it cannot take parameters whose type is a type parameter of the enclosing generic function.', bad: 'fn n<T>(xs: T[]): int { fn go(i: int): int { if i >= len(xs) { return 0; } return 1 + go(i + 1); } return go(0); }', fix: 'pass xs as a parameter of go' },
  E028: { title: 'bad qualified name', text: 'module.item names a module without that item, or the item lives in another file.' },

  W001: { title: 'unused variable', text: 'The variable is declared and never read. Prefix it with _ to silence the warning.' },
  W002: { title: 'unused parameter', text: 'The parameter is never read. Prefix it with _ when that is intended.' },
  W003: { title: 'shadowing', text: 'A new variable hides one of the same name from an outer scope.' },
  W004: { title: 'unreachable code', text: 'Statements after return, break, continue or an endless loop never run.' },
  W005: { title: 'function never called', text: 'Nothing calls this function. Prefix it with _ to keep it on purpose.' },
  W006: { title: 'self comparison', text: 'Comparing a value with itself always gives the same answer.', bad: 'if x == x { }' },
  W007: { title: 'var never reassigned', text: 'A var that is only assigned once should be a let.' },
  W008: { title: 'result unused', text: 'The statement computes a value and throws it away. For pure builtins such as abs(x); this is almost always a mistake.' },
  W009: { title: 'self assignment', text: 'Assigning a variable to itself does nothing.', bad: 'x = x;' },
  W010: { title: 'unreachable match pattern', text: 'An earlier arm already covers every value this pattern could match.' },
  W011: { title: 'generic never called', text: 'Generic bodies are only checked when instantiated, so an uncalled generic is not checked at all.' },
};

export function explain(code: string): string | null {
  const e = EXPLAIN[code.toUpperCase()];
  if (!e) return null;
  let out = `${code.toUpperCase()}: ${e.title}\n\n${e.text}\n`;
  if (e.bad) out += `\n  bad:  ${e.bad}\n`;
  if (e.fix) out += `${e.bad ? '' : '\n'}  good: ${e.fix}\n`;
  return out;
}
