# Lumen

A small statically-typed language with the whole toolchain in one repo: lexer, parser,
static analyzer, tree-walking interpreter, bytecode compiler + VM, and a C backend.
TypeScript, no runtime dependencies, Node >= 22.18. Arabic summary: [README.ar.md](README.ar.md). New to the language? Start with [docs/tutorial.md](docs/tutorial.md), its examples are run by the tests.

## Why TypeScript

Sum types + exhaustive `switch` make AST passes safe to refactor, Node 22+ runs `.ts`
directly (no build step), and anyone can clone and run it. Rust would be faster, but the
point here is the architecture, not the benchmark.

## Pipeline

```
source ─► Lexer ─► Parser ─► Analyzer ─┬─► Interpreter   (walks the typed AST)
          tokens    AST      types,    │
                             scopes,   ├─► Compiler ─► Bytecode ─► VM
                             lints     │
                                       └─► C codegen ─► gcc/clang ─► native
                              (-O: constant folding runs between analyzer and backends)
```

The analyzer annotates the AST in place (`expr.ty`, resolved `VarSym`/`FnSym`, slot numbers),
so every backend consumes the same typed tree and never re-does name resolution.
Backends refuse to run on a tree that has errors; warnings don't block.

```
src/
  diagnostics.ts   Span, Source, rustc-style error rendering
  lexer.ts         tokens
  parser.ts        recursive descent + precedence climbing, error recovery
  ast.ts types.ts  node types, symbols, builtin signatures
  analyzer.ts      scopes, type check, flow analysis, lints
  optimizer.ts     constant folding (also pure builtins on literals), dead branch removal
  interpreter.ts   AST evaluator
  bytecode.ts      opcodes, module layout, disassembler
  compiler.ts      AST -> bytecode
  vm.ts            stack machine
  cgen.ts          AST -> C99
  runtime.ts       semantics shared by all backends (int overflow, float printing, builtins)
  modules.ts       import resolution, bundles several files into one program
  explain.ts       long descriptions behind `lumen explain CODE`
  fmt.ts           whitespace formatter behind `lumen fmt`
  repl.ts          the `lumen repl` loop
  pipeline.ts      glue
  cli.ts           the `lumen` command (turns on the V8 compile cache, then loads main.ts)
examples/  test/
editors/vscode/    syntax highlighting for VS Code (copy the folder into the extensions directory)
```

## The language

```
fn fib(n: int): int {
  if n < 2 { return n; }
  return fib(n - 1) + fib(n - 2);
}

var i = 0;
while i < 10 {
  print("fib(" + str(i) + ") = " + str(fib(i)));
  i += 1;
}
```

Number literals can be written `0xFF`, `0b1010`, `1_000_000` and, for floats, `1e9` or `2.5e-5`; comments are `// line` and `/* block */`. Types `int float bool string`, one-dimensional arrays (`int[]`, `Point[]`, ...) user `struct`s and `enum`s; `let` (immutable) / `var`; `fn`, `if/else`, `while`, `for i in 0..n` (optionally `step 2`, a positive literal) / `for x in array` / `for i, x in array` (with the position), `let [a, b] = pair();` and `let Point { x, y: h } = p;` bind several names at once (a hidden copy is indexed or read, so the right side runs once). Strings also accept the escapes `\x41` (ASCII only) and `\u{1F600}` (any code point, stored as UTF-8). `loop { ... }` is `while true { ... }` (leave it with `break`). Tuples: `(1, "a")` has the type `(int, string)`, its parts are read with `t.0`, `t.1` or taken apart with `let (a, b) = t;` or `for (a, b) in pairs`; they print as `(1, "a")` and compare with `==`. A tuple is a generic struct `Tuple2<A, B>` behind the scenes (up to any size, written when first used). Patterns nest (`let ((a, b), c) = t;`) and `t.0.1` chains work.
 	 
  \ \"`, `A` (ASCII only) and `{1F600}` (any code point, stored as UTF-8).
`break/continue/return`; operators `+ - * / % == != < <= > >= && || !` plus `+= -= ...`.
Builtins: `read_file(path)` and `write_file(path, text)` (whole files as UTF-8 text, they trap when the file cannot be opened), `clock()` (wall clock in milliseconds, for timing), `args()` (the words after `--` on the command line: `lumen run f.lum -- a b`), `read_line()` (next stdin line without its newline, empty at the end), `at_eof()`, `assert(cond, message)` (stops the program when `cond` is false), `exit(code)` (status 0..255, output so far is kept), `print(x)` (several values print space-separated: `print("n =", n)`), `str(x)`, `int(f)`, `float(i)`, `len(s | arr)`, `push(arr, x)`, `pop(arr)`, `insert(arr, i, x)`, `remove(arr, i)` (returns the element; both trap when `i` is out of bounds), `sort(arr)` (int, float or string elements, in place), `reverse(arr)`, `slice(arr, start, n)` (a shallow copy, traps out of range; `arr[lo..hi]` is the same as `slice(arr, lo, hi - lo)`, and either end can be left out (`arr[1..]`, `arr[..2]`) or made inclusive (`arr[2..=3]`), the array and `lo` are written twice so keep them side-effect free; on a string `slice` is `substr`, so `s[1..4]` works too; `s[i]` is the whole UTF-8 character that starts at byte `i`, read only, and `for ch in text` steps by character), and `for ch in text` walks the characters), `contains(arr, x)`, `sqrt(f)` (traps on negatives), `floor(f)`, `ceil(f)` (both return floats), `abs(x)`, `min(a, b)`, `max(a, b)` (int or float, both sides the same type), and byte-based string helpers: `byte(s, i)`, `chr(n)` (ASCII 1..127), `substr(s, start, n)`, `find(s, needle)` (index or -1), `split(s, sep)`, `join(parts, sep)` `trim(s)` (ASCII whitespace), `upper(s)` / `lower(s)` (ASCII letters only), `replace(s, from, to)` (all occurrences, `from` must not be empty), `starts_with(s, p)`, `ends_with(s, p)`, `repeat(s, n)`, and `parse_int(s, fallback)` / `parse_float(s, fallback)` (plain decimal text only, anything else including overflow gives the fallback). `substr` traps when a cut lands inside a UTF-8 character or out of range, `split` on an empty separator, `byte` out of range. Strings also order with `<`, `<=`, `>`, `>=` by UTF-8 byte value. String literals can hold expressions, `"sum is {a + b}"`, which the lexer rewrites to `"sum is " + str(a + b)`; write `\{` and `\}` for literal braces.
Structs: `struct Point { x: float, y: float }`, `Point { x: 1.0, y: 2.0 }`, `p.x`, `p.x = 3.0`, `p.x += 1.0`; they can nest and be stored in arrays.
Enums: `enum Light { Red, Yellow, Green }`, values are written `Light.Red`, compare with `==`, print by variant name.
`match` (statement) works on enums, bool, int and string:

```
match light {
  Red => { stop(); }
  Yellow | Green => { go(); }
}
```

`match` also works as an expression, `let n = match c { Red => 1, _ => 0 };` (comma separated arms, same exhaustiveness rules, all arms must have one type, only the chosen arm runs). `if` works as an expression too, `let s = if n < 0 { "neg" } else { "pos" };`: both branches are required, `else if` chains, and it is sugar for a match on the condition. `if let Some(x) = opt { ... } else { ... }` matches one pattern and ignores the rest (sugar for a match with a `_` arm); `while let Some(x) = next() { ... }` loops until the pattern stops matching.

A block can be a value: `let n = { let a = 20; a + 22 };`, as a `match` arm (`Add(n) => { total += n; "added" }`) or an `if` branch. The last item is the result; `return` leaves the whole function (`let v = { if n < 0 { return -1; } n * 2 };`) and `break`/`continue` only reach loops inside the block. An arm may carry a guard, `Circle(r) if r > 1.0 => ...`; the guard runs after the pattern bound its names, and if it is false the next arm is tried. A guarded arm does not count towards exhaustiveness (`E020`) or reachability (`W010`).

Variants can carry data, which `match` takes apart (recursive types work):

```
enum Shape { Circle(float), Rect(float, float), Unit }
enum List { Nil, Cons(int, List) }
let s = Shape.Rect(3.0, 4.0);
let area = match s { Circle(r) => 3.0 * r * r, Rect(w, h) => w * h, Unit => 1.0 };
```

Patterns bind names (`Rect(w, _)`), `Circle` alone ignores the data. An arm with several patterns cannot bind names (`E022`).
Enums with data are references and cannot be compared with `==`; use `match`. Structs compare field by field with `==` and `!=` when every field is a scalar, a plain enum or another such struct (a generated `Name$eq` function does it); arrays and structs holding arrays or data enums still cannot be compared.

Arms are variants (unqualified), literals, or `_`. The analyzer requires the match to be exhaustive Int arms can also be ranges, `0..10` (end excluded) or `1..=9` (end included), mixed with literals as `0 | 5..9`; they work as guards on the match value, so that value must be a variable or field, and a final `_` arm is still required.
(`E020`, with the missing variants listed) and warns about unreachable patterns (`W010`). A function whose
every arm returns counts as returning on all paths.
Methods: `impl Counter { fn new(step: int): Counter { ... } fn tick(self) { self.n += 1; } }`, called as
`Counter.new(5)` and `c.tick()`. Works for structs and enums. `self` is the receiver (a reference), methods are
resolved statically and compile down to plain functions named `Counter$tick` (shown as `Counter.tick` in messages).
Arrays: `[1, 2, 3]`, `a[i]`, `a[i] = x`, `a[i] += x`. Empty literals need a known type: `let xs: int[] = [];`.
Function values: `fn(int, int): int` is a type, a function name is a value (`apply(double, 4)`), and `fn(x: int): int { return x + 1; }` is an anonymous function. Any expression of function type can be called: `f(x)`, `pick("double")(8)`, `table[1](9)`, and struct fields (`op.run(3, 4)`). Anonymous functions capture the locals they mention. A `let` or parameter is copied in when the closure is created; a `var` is *shared*: the analyzer keeps it in a one-element array that the enclosing function and every closure read and write, so `make_counter()` style state works and each call gets its own cell. A named `fn` inside a function body is a local function, sugar for `let name = fn(...) {...};` (it captures like a lambda; one that calls itself is hoisted to a real function, so it can only see globals and its own parameters). Function values cannot be compared or printed. An array of functions is written `(fn(int): int)[]`. Where the expected type is known (an argument, a typed `let`), parameter types and the return type can be left out and an `=>` body replaces the block: `list.map(xs, fn(x) => x * x)`. A block body works too if it returns a value. Elsewhere it is E030.

Generics: `fn map<T, U>(xs: T[], f: fn(T): U): U[] { ... }`. Type arguments are always inferred from the call (`E024` when a parameter is not mentioned by any argument), and every distinct set of type arguments is checked and compiled as its own copy of the function (monomorphization), so the three backends need no special support. A generic function is only checked when it is called, and it cannot be used as a value.

Trailing commas are accepted in parameter lists, call arguments, array literals and struct literals, and `P { x, y }` is shorthand for `P { x: x, y: y }`. A struct literal can copy the rest of its fields from another value: `Config { width: 120, ..base }` (the value after `..` must be a variable or a field path, it is read once per copied field). Parameters can have defaults, `fn greet(name: string, greeting: string = "hello")`: a call may leave out the trailing arguments and the default expression is evaluated at the call (methods and associated functions too, `c.bump()`). Calls can name arguments, `box(height: 5, width: 4)` or `box(3, label: "x")`: positional ones come first, the rest are placed by parameter name and everything is evaluated in parameter order. Methods and associated functions take them too. Several targets can be assigned at once, `a, b = b, a;` or `xs[0], xs[3] = xs[3], xs[0];`: all right sides are computed first.

A generic function whose type parameter no argument mentions takes it from the type the result is expected to have: `let m: map.Map<int> = map.new();`.

Generic structs: `struct Box<T> { value: T }`, written `Box<int>` in types and built with plain literals (`Box { value: 41 }`, the arguments are inferred from the fields or from the expected type). Each instance is its own struct (`Box<int>` and `Box<string>` are unrelated types) and prints as `Box { value: 41 }`. Works together with generic functions (`fn unbox<T>(b: Box<T>): T`).

Generic enums: `enum Option<T> { Some(T), None }`, written `Option<int>`. `Option.Some(7)` infers its argument, `Option.None` takes it from the expected type (`let n: Option<int> = Option.None;`, a return type, a parameter) and is `E024` when nothing says which instance is meant. Matching works as usual with the instance's variants.

Methods on generic types: `impl<T> Stack<T> { fn new(first: T): Stack<T> { ... } fn push(self, x: T) { ... } }`, used as `Stack.new(1)` and `s.push(2)`. Each method is a generic function over the impl's parameters, so it follows the same inference and instantiation rules, and `impl<T: Shape> Holder<T>` puts a trait bound on every method.

Impls can also target one instance of a generic type: `impl Show for Box<int> { ... }` and `impl Box<float> { ... }` (each instance gets its own).

Traits: `trait Shape { fn area(self): float; }` declares method signatures and `impl Shape for Circle { ... }` provides them (`E026` for a missing or mismatching method). A method with a body in the trait is a default; impls that do not define it get their own copy. Two ways to use a trait:

- **Static**, through a bound: `fn total<T: Shape>(xs: T[])`. Calling it with a type that has no impl is `E025`. Generics are monomorphized, so `s.area()` is resolved per instance at no runtime cost.
- **Dynamic**, through `dyn Shape`: `let shapes: dyn Shape[] = [Shape.from(Circle { r: 1.0 }), Shape.from(Rect { w: 2.0, h: 3.0 })];` and `s.area()` on each element. `dyn Shape` is a closed-world enum the analyzer builds from every `impl Shape for X` in the program (one variant per impl, dispatch is a `match`), so it works unchanged on all three backends. A value of an implementing type is accepted wherever a `dyn Shape` is expected (arguments, `let` with a type, returns, array elements); `Shape.from(x)` does the same explicitly. A `dyn Shape` also satisfies `T: Shape` bounds.

Modules: `import "geometry.lum";` on its own line pulls in another file (path relative to the importing file). Imports are resolved before lexing: each file is read once, dependencies come first, and the result is one program. Diagnostics still point at the right file and line. Each file is its own namespace for functions, structs, enums, traits and global `let`/`var`s: two files may declare the same name, and a name that clashes is renamed internally (`cats$describe`, printed as `describe`). Inside a file an unqualified name means that file's own declaration; from another file write `cats.describe(c)`, `cats.Item { ... }`, `x: cats.Item`. An unqualified use of a name that several modules declare (and the current file does not) is `P006`; a qualifier naming the wrong file or a missing item is `E028`. Visibility is per file: a top-level `fn`, `struct` or `enum` can be used from another file only when declared `pub` (`E027` otherwise). A missing file is `P004`; import cycles are tolerated. See `examples/modules/` and `examples/namespaces/`. Traits are written `module.Trait` in bounds and `dyn` types and follow the same `pub` rule (`E027`); a global `let` is private to its file; methods' names follow their type.

Semantics worth knowing:

- `for` is sugar over `while` (desugared in the parser); the counter is advanced before the body, so `continue` is safe. The range end is evaluated once, `a..b` excludes `b`, and the loop variable is immutable.
- No implicit conversions. `1 + 1.5` is a type error; write `float(1) + 1.5`.
- `int` is a 53-bit-safe integer and traps on overflow (`runtime error: integer overflow`).
  Same behaviour in the interpreter, the VM and the generated C, so results match everywhere.
- `/` on ints truncates toward zero; division and modulo by zero trap.
- Operands evaluate left to right; `&&` / `||` short-circuit.
- Functions see globals declared *before* them. Recursion works, call depth is capped at 1000 (`run --engine interp` runs on a thread with a large stack so it reaches the same cap).
- A loop can carry a label, `rows: for r in grid { for c in r { if c < 0 { continue rows; } if c > 9 { break rows; } } }`. The parser turns the jump into a flag that each loop in between checks right after it ends, so the backends see ordinary loops.
- `len` counts UTF-8 bytes (strings) or elements (arrays).
- Tuple patterns in `match`: `match (n % 3, n % 5) { (0, 0) => ..., (0, _) => ..., _ => ... }`. Parts are int, string or bool literals, `_`, or a name that binds that part inside the arm (`(x, 0) => x`, a guard may read them: `(x, 0) if x > 3 => ...`; with `|` every alternative must bind the same names: `(x, 0) | (0, x) => ...`). They become guards, so the written tuple may only hold variables, fields and arithmetic (it is re-evaluated per arm) and a final `_` arm is needed.
- `const LIMIT = 10;` is a `let` written for constants: same rules, assigning to it is E005. It works at the top level and inside functions.
- try: `let n = try parse(s);` continues with the payload when the value is `Ok` / `Some`, otherwise the function returns the `Err(msg)` / `None` right there. The function must return a `Result<T>` or `Option<T>` (P001 otherwise); `var` works too. It is a rewrite into a `match` whose `Ok` arm holds the rest of the block, so it only applies as a `let` / `var` initializer or as a statement of its own (`try check(a);` bails on the error and drops the value). See `examples/std/try_result.lum`.
- `x.f(args)` on a value with no such method falls back to `f(x, args)` when `f` is a builtin, a function whose first parameter has x's type, or a generic function whose first parameter accepts it, so `xs.len()`, `s.trim().upper()` and `xs.map(fn(x) => x * 2)` (after importing `std/list.lum`) work. Real methods win.
- Arrays are references (`let b = a;` aliases); indexing is bounds-checked, `pop` on an empty array traps. `==` on arrays/structs is rejected. Arrays can nest (`int[][]`, rows may have different lengths).
- Structs are references too (`let q = p;` aliases) and print as `Point { x: 1.0, y: 2.0 }`. Literal fields run in the order written. A struct cannot contain itself by value; use an array field (`kids: Node[]`).
- `Name {` after `if` / `while` is a block, wrap a struct literal in parentheses there.

## Standard library

`lib/` holds modules written in Lumen itself, imported with an `std/` prefix. Diagnostics inside them are not reported unless they are errors.

```
import "std/map.lum"

let ages: map.Map<int> = map.new();   // V is inferred from the annotation
map.set(ages, "ada", 36);
print(map.get(ages, "ada", 0));      // 36; the third argument is the fallback
```

`std/option.lum`: generic `Option<T>` (`Some`/`None`) and `Result<T>` (`Ok`/`Err(string)`) with `unwrap_or`, `is_some`, `ok_or`, `is_ok`, `map_option`, `map_result`, and over arrays `find_by(xs, test)` and `first(xs)`, which return an `Option<T>`. `std/math.lum`: `gcd`, `lcm`, `pow`, `clamp`, `is_prime`, `sign`, `factorial`, `isqrt`, `digit_sum` on ints.

`std/list.lum`: `map`, `filter`, `fold`, `any`, `all`, `count`, `find_index`, `take`, `drop`, `zip_with`, `sort_by` (stable, takes a `before(a, b)` function), `flatten`, `flat_map`, `unique`, `max_of`, `min_of`, `equal`, `index_of`, `reversed`, `take_while`, `drop_while`, `chunks`, and with tuples `zip`, `enumerate`, `partition` over any element type (they take function values, so `list.map(xs, fn(x) => x * 2)`), plus `range(lo, hi)` and `sum`.

`std/list.lum` also has `product`, `rotate(xs, k)` and `count_by(xs, key)` (a `Map<int>`).

`std/format.lum`: `commas(n)` (`1,234,567`), `table(rows)` (columns padded to the widest cell by characters, no trailing spaces) and `percent(part, whole)`.

`std/date.lum`: calendar arithmetic on plain ints, `to_days(y, m, d)` / `from_days(n)` (days since 1970-01-01, a `(y, m, d)` tuple), `add_days`, `weekday` (0 is monday), `is_leap`, `days_in_month` and `iso(y, m, d)`.

`std/encoding.lum`: `to_hex(n)`, `from_hex(s)` (-1 when it is not hex), `hex_encode(s)` (two digits per byte) and `base64_encode(s)`.

`std/matrix.lum`: int matrices as `int[][]`, `new(rows, cols, fill)`, `identity`, `transpose`, `add`, `mul` (traps when the sizes do not match) and `pow(m, n)` by squaring.

`std/json.lum`: a `Json` enum (`Null`, `Bool`, `Num`, `Str`, `Arr`, `Obj`), `parse(text)` returning `{ ok, json }`, `stringify(j)` and `quote(s)`. Numbers are floats and objects keep their key order.

`std/csv.lum`: `parse(text)` gives a `string[][]` (quoted fields, `""` inside quotes, `\r\n` or `\n` line ends), `format(rows)` writes it back.

`std/path.lum`: text-only helpers for `/` separated paths, `basename`, `dirname`, `ext` and `combine(a, b)` (named so because `join` is a builtin).

`std/stats.lum`: `mean`, `median`, `variance` (population), `stddev` and `min_max` (a tuple) over `float[]`.

`std/heap.lum`: a priority queue, `heap.new(before)` takes the ordering (`fn(a, b) => a < b` pops the smallest first), then `add`, `take`, `peek` and `size`.

`std/queue.lum`: a FIFO queue, `queue.new()`, `put`, `next` (traps when empty) and `size`.

`std/set.lum`: a set of strings (`new`, `from`, `add`, `has`, `drop`, `size`, `items`, `union`, `intersect`, `minus`), insertion ordered, hashed lookups.

`std/random.lum`: a seeded Park-Miller generator, `new(seed)`, `step`, `below(r, n)`, `between(r, lo, hi)` and `shuffle(r, xs)`. The same seed gives the same numbers on every engine.

`std/bits.lum`: `band`, `bor`, `bxor`, `shl`, `shr`, `popcount` for non-negative ints (plain arithmetic, the language has no bitwise operators).

`std/test.lum`: `eq_int`, `eq_str`, `eq_float(got, want, eps)` and `is_true` for `lumen test`; a failing one reports `expected X, got Y`.

`std/text.lum` (also `char_count`, and `pad_left` / `pad_right` pad by characters): `pad_left`, `pad_right`, `is_digits`, `is_alpha`, `reversed`, `count(s, needle)`, `words(s)`, `lines(s)`, `chars(s)`, `is_blank`, `capitalize`, `center` and `fixed(x, digits)` (a float with a set number of decimals) (ASCII, byte based). A function in a module cannot take a builtin's name (`E006`), which is why it is `reversed`.

`std/text.lum` also has `truncate(s, width)` (whole characters, ends with `...`), `title(s)`, `wrap(s, width)` (greedy word wrap into lines) and `glob(pattern, s)` (`*` and `?`); `std/math.lum` has `lerp`, `hypot` and `fpow(base, exp)` for float bases.

`std/map.lum`: a string-keyed `Map<V>` with `new`, `set`, `get(m, key, fallback)`, `has`, `delete`, `size`, `keys`, `values`, `entries` (a `(string, V)[]`) and `update(m, key, start, f)`. Keys stay in insertion order and a hash index makes lookups fast; `delete` rebuilds the index.

## Static analysis

Errors (block execution): `E001` unknown variable, `E002` unknown function, `E003` type mismatch,
`E004` wrong arity, `E005` assign to immutable, `E006` redeclaration, `E007` missing return on some path,
`E008` break/continue outside loop, `E009` return at top level, `E010` void used as value,
`E011` non-bool condition, `E012` constant division by zero, `E013` bad array literal (empty without a type), `E014` constant negative index, `E016` unknown type/struct, `E017` recursive struct, `E018` bad struct literal (missing/unknown/duplicate field), `E019` bad field access / unknown method, `E020` non-exhaustive match, `E021` unknown enum variant, `E022` wrong number of values for a variant (constructor or pattern), `E023` a closure captured a `var` it could not share (internal fallback), `E024` type parameter that cannot be inferred, `E025` type does not implement a required trait (or unknown trait), `E026` impl missing or mismatching a trait method, `E027` private item used from another file. Parse-level: `E028` qualified name that is not in that module, `P004` import of a missing file, `P006` unqualified name declared in several modules, `P005` `pub` on something that is not a fn/struct/enum.

Lints (warnings): `W001` unused variable, `W002` unused parameter, `W003` shadowing, `W004` unreachable code
/ constant condition, `W005` function never called, `W006` self-comparison, `W007` `var` never reassigned,
`W008` expression statement with no effect (also a pure builtin such as `abs(x);` whose result is dropped), `W009` self-assignment, `W010` unreachable match pattern, `W011` generic function never called (its body was never checked). Prefix a name with `_` to silence W001/W002/W007.

Missing-return detection is a real flow analysis (`diverges` / `returns` per statement), so
`while true { }` without `break` counts as terminating and `if` needs both branches to return.
Typos get a "did you mean" suggestion (edit distance).

## Usage

```
npm install                      # only needed for tsc / @types/node
node src/cli.ts run examples/fib.lum
node src/cli.ts run examples/fib.lum --engine interp
node src/cli.ts run -e 'print("sum", 1 + 2);'    # code straight from the command line
node src/cli.ts run examples/fib.lum --engine c    # build with gcc/clang/cc into a temp dir and run it
node src/cli.ts check examples/errors.lum          # diagnostics only, exit 1 on errors
node src/cli.ts check examples/lints.lum --json    # for editor/CI integration
node src/cli.ts check a.lum b.lum c.lum            # several files, exit 1 if any fails
node src/cli.ts disasm examples/fib.lum
node src/cli.ts emit-c examples/fib.lum -o fib.c
node src/cli.ts build examples/bench.lum -o bench  # emit C + gcc/clang/cc
node src/cli.ts bench examples/bench.lum           # interpreter vs VM
node src/cli.ts repl                              # interactive; a bare expression prints its value, :type expr, :reset, :help
node src/cli.ts fmt --write file.lum              # re-indent by bracket depth (--check for CI)
node src/cli.ts test file.lum                   # run every `fn test_*()`, failed assert() = failed test (--only name to filter)
node src/cli.ts explain E003                      # what a diagnostic code means, with a bad/good example
node src/cli.ts --version                        # lumen 0.1.0
npm test                         # unit tests + cross-backend parity
npm run typecheck
```

`bench.lum` on one machine: tree-walker ~520 ms, VM ~400 ms, native via C ~60 ms (mostly process start).

## License

MIT, see `LICENSE`.

## Memory in the C backend

Generated C carries a small conservative mark-and-sweep collector (about 120 lines, in the prelude of every
emitted file). Strings, arrays, structs and enums-with-data are allocated through `lm_alloc`; roots are the C stack
(registers are spilled with `setjmp`) and the registered globals. A collection runs once 4 MB (or as much as survived
the last collection) has been allocated. `LM_GC_STATS=1 ./prog` prints a summary at exit and `LM_GC_STRESS=1`
collects on every allocation, which the test suite uses to catch missed roots. It assumes a downward-growing stack and
GCC/Clang builtins, like the rest of the backend.

## Testing

`test/backends.test.ts` runs every example through interpreter, VM, and both with `-O`, and asserts
identical output (including runtime errors). If a C compiler is on PATH it also compiles each example
and compares the native output. The C backend hoists calls into temporaries so that evaluation order
matches Lumen's left-to-right rule (C leaves argument order unspecified).

## Known limits / next steps

- A generic function body is only type checked when it is instantiated (an uncalled one still gets its undeclared names reported); a global is private to its file, traits are namespaced per file and need `pub` to be used from another file.
- A local function that calls itself reads the enclosing function's `let` locals and parameters (copied in when it is defined; arrays and structs still share, a `var` has to be copied into a `let` first, E023).
- The VM is a switch loop with fused compare-and-jump and increment ops (one try/catch around the whole loop); a register VM would be the next speed step. `fib(30)` plus a 3M iteration loop takes about 1.2s on the VM.
- Analyzer is single-pass over statements; no inter-procedural analysis (e.g. purity, call graph reachability beyond W005).
- There is no `?` operator; use `let x = try e;` instead (see "try"), or match / `and_then`. `try` works as the initializer of a `let` / `var` (also a destructuring one) or as a statement, never inside a block expression, and the function must return a `Result` or an `Option`.
