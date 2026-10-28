# Lumen

A small statically-typed language with the whole toolchain in one repo: lexer, parser,
static analyzer, tree-walking interpreter, bytecode compiler + VM, and a C backend.
TypeScript, no runtime dependencies, Node >= 22.18. Arabic summary: [README.ar.md](README.ar.md).

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
  optimizer.ts     constant folding, dead branch removal
  interpreter.ts   AST evaluator
  bytecode.ts      opcodes, module layout, disassembler
  compiler.ts      AST -> bytecode
  vm.ts            stack machine
  cgen.ts          AST -> C99
  runtime.ts       semantics shared by all backends (int overflow, float printing, builtins)
  pipeline.ts      glue
  cli.ts           the `lumen` command
examples/  test/
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

Types `int float bool string`, one-dimensional arrays (`int[]`, `Point[]`, ...) user `struct`s and `enum`s; `let` (immutable) / `var`; `fn`, `if/else`, `while`, `for i in 0..n` / `for x in array`,
`break/continue/return`; operators `+ - * / % == != < <= > >= && || !` plus `+= -= ...`.
Builtins: `print(x)`, `str(x)`, `int(f)`, `float(i)`, `len(s | arr)`, `push(arr, x)`, `pop(arr)`.
Structs: `struct Point { x: float, y: float }`, `Point { x: 1.0, y: 2.0 }`, `p.x`, `p.x = 3.0`, `p.x += 1.0`; they can nest and be stored in arrays.
Enums: `enum Light { Red, Yellow, Green }`, values are written `Light.Red`, compare with `==`, print by variant name.
`match` (statement) works on enums, bool, int and string:

```
match light {
  Red => { stop(); }
  Yellow | Green => { go(); }
}
```

`match` also works as an expression, `let n = match c { Red => 1, _ => 0 };` (comma separated arms, same exhaustiveness rules, all arms must have one type, only the chosen arm runs).

Variants can carry data, which `match` takes apart (recursive types work):

```
enum Shape { Circle(float), Rect(float, float), Unit }
enum List { Nil, Cons(int, List) }
let s = Shape.Rect(3.0, 4.0);
let area = match s { Circle(r) => 3.0 * r * r, Rect(w, h) => w * h, Unit => 1.0 };
```

Patterns bind names (`Rect(w, _)`), `Circle` alone ignores the data. An arm with several patterns cannot bind names (`E022`).
Enums with data are references and cannot be compared with `==`; use `match`.

Arms are variants (unqualified), literals, or `_`. The analyzer requires the match to be exhaustive
(`E020`, with the missing variants listed) and warns about unreachable patterns (`W010`). A function whose
every arm returns counts as returning on all paths.
Methods: `impl Counter { fn new(step: int): Counter { ... } fn tick(self) { self.n += 1; } }`, called as
`Counter.new(5)` and `c.tick()`. Works for structs and enums. `self` is the receiver (a reference), methods are
resolved statically and compile down to plain functions named `Counter$tick` (shown as `Counter.tick` in messages).
Arrays: `[1, 2, 3]`, `a[i]`, `a[i] = x`, `a[i] += x`. Empty literals need a known type: `let xs: int[] = [];`.

Semantics worth knowing:

- `for` is sugar over `while` (desugared in the parser); the counter is advanced before the body, so `continue` is safe. The range end is evaluated once, `a..b` excludes `b`, and the loop variable is immutable.
- No implicit conversions. `1 + 1.5` is a type error; write `float(1) + 1.5`.
- `int` is a 53-bit-safe integer and traps on overflow (`runtime error: integer overflow`).
  Same behaviour in the interpreter, the VM and the generated C, so results match everywhere.
- `/` on ints truncates toward zero; division and modulo by zero trap.
- Operands evaluate left to right; `&&` / `||` short-circuit.
- Functions see globals declared *before* them. Recursion works, call depth is capped at 1000.
- `len` counts UTF-8 bytes (strings) or elements (arrays).
- Arrays are references (`let b = a;` aliases); indexing is bounds-checked, `pop` on an empty array traps. Nested arrays and `==` on arrays/structs are rejected.
- Structs are references too (`let q = p;` aliases) and print as `Point { x: 1.0, y: 2.0 }`. Literal fields run in the order written. A struct cannot contain itself by value; use an array field (`kids: Node[]`).
- `Name {` after `if` / `while` is a block, wrap a struct literal in parentheses there.

## Static analysis

Errors (block execution): `E001` unknown variable, `E002` unknown function, `E003` type mismatch,
`E004` wrong arity, `E005` assign to immutable, `E006` redeclaration, `E007` missing return on some path,
`E008` break/continue outside loop, `E009` return at top level, `E010` void used as value,
`E011` non-bool condition, `E012` constant division by zero, `E013` bad array literal (empty without a type, nested), `E014` constant negative index, `E016` unknown type/struct, `E017` recursive struct, `E018` bad struct literal (missing/unknown/duplicate field), `E019` bad field access / unknown method, `E020` non-exhaustive match, `E021` unknown enum variant, `E022` wrong number of values for a variant (constructor or pattern).

Lints (warnings): `W001` unused variable, `W002` unused parameter, `W003` shadowing, `W004` unreachable code
/ constant condition, `W005` function never called, `W006` self-comparison, `W007` `var` never reassigned,
`W008` expression statement with no effect, `W009` self-assignment, `W010` unreachable match pattern. Prefix a name with `_` to silence W001/W002/W007.

Missing-return detection is a real flow analysis (`diverges` / `returns` per statement), so
`while true { }` without `break` counts as terminating and `if` needs both branches to return.
Typos get a "did you mean" suggestion (edit distance).

## Usage

```
npm install                      # only needed for tsc / @types/node
node src/cli.ts run examples/fib.lum
node src/cli.ts run examples/fib.lum --engine interp
node src/cli.ts check examples/errors.lum          # diagnostics only, exit 1 on errors
node src/cli.ts check examples/lints.lum --json    # for editor/CI integration
node src/cli.ts disasm examples/fib.lum
node src/cli.ts emit-c examples/fib.lum -o fib.c
node src/cli.ts build examples/bench.lum -o bench  # emit C + gcc/clang/cc
node src/cli.ts bench examples/bench.lum           # interpreter vs VM
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

- No nested arrays, methods or closures yet.
- The VM is a straightforward switch loop (one try/catch around the whole loop); a register VM or superinstructions would be the next speed step.
- Analyzer is single-pass over statements; no inter-procedural analysis (e.g. purity, call graph reachability beyond W005).
