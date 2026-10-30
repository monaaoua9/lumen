# How Lumen is put together

A short tour of the decisions behind the code, for someone about to read it or change it.

## The goal

A small statically typed language that is complete enough to write real programs in (parsers, graph algorithms, text tools) and small enough to read in an afternoon. The interesting part is that one typed tree feeds four different backends and they all have to print the same thing.

## One tree, four backends

```
source -> lexer -> parser -> analyzer -> (optimizer) -> interpreter
                                                     -> bytecode -> VM
                                                     -> JavaScript -> V8
                                                     -> C99 -> gcc/clang
```

The analyzer fills in types, resolved names and slot numbers on the AST itself. After that no backend does name resolution or type checking, they only walk a tree that is known to be well typed. That is why each backend is small: the interpreter is about 270 lines, the VM 250.

The cost of that choice is that a bug in the analyzer shows up in all four backends at once. The test suite compensates by running every example and thousands of generated programs on every engine and comparing the output byte for byte (`test/differential.test.ts`).

## Types are strings

A type is a plain string: `int`, `@Point` for a struct, `#Shape` for an enum, `int[]`, `<fn(int):int>` for a function. It is not elegant, but equality is `===`, printing a type in an error message is free, and a generic function can be copied by rewriting strings.

Generics are monomorphized: calling `max_of<int>` clones the function declaration with `T` replaced by `int`, so no backend knows generics exist. Tuples are generic structs named `Tuple2`, `Tuple3` and so on.

## Most syntax is desugared in the parser

`for`, string interpolation, `if` as an expression, `try`, labelled loops, destructuring and most patterns become a smaller set of nodes before the analyzer sees them: `let`, `assign`, `while`, `match`, blocks. A `for i in 0..n` is a `while` with a hidden counter. An `if` used as a value is a `match` on a bool.

This keeps the analyzer and the backends short, and it means a new surface feature usually touches only the parser. The price is error messages: they have to be mapped back to what the user wrote, which is why some desugared nodes carry extra metadata (the cover information for exhaustiveness checking, for example).

## Values at run time

Ints are JavaScript numbers that trap when they leave the safe integer range (2^53), and the C backend checks the same limit, so overflow behaves identically everywhere. Floats are doubles. Strings are UTF-8 and offsets count bytes. Structs are arrays of fields, an enum with data is `[tag, ...payload]`, an enum without data is just its number.

`src/runtime.ts` holds everything the engines must agree on: overflow checks, float printing, the builtins. The interpreter, the VM and the JS backend call it directly; the C backend carries its own copy written in C and the differential tests keep the two honest.

## The backends

**Interpreter.** Walks the tree. Slow, simple, and the reference for the others. It recurses on the host stack, so `run` starts it on a thread with a big one.

**VM.** A stack machine with one flat array of values and fused instructions for the common shapes (compare a local with a constant and jump, increment a local). It is faster than the interpreter by a constant factor, not an order of magnitude, because it is itself running on V8.

**JavaScript.** Emits one JS function per Lumen function and lets V8 compile it. This is the default engine because it is several times faster than the VM at no cost in complexity. Runtime errors keep their stack trace through a shadow call stack: each call passes a span index, and the function prologue records it.

**C.** Emits C99 and calls gcc, clang or cc. It carries a small mark and sweep collector that finds roots by scanning the C stack conservatively, so the generated code needs no bookkeeping. A string variable that is only appended to is detected at compile time and grown in place, otherwise `s += x` in a loop would copy the whole string every time.

## Modules and packages

`import "file.lum"` is resolved before lexing: files are read once, dependencies first, and concatenated into one program with segment markers, so error messages can still say which file and line they mean. A module's name is its file name.

Packages add a `lumen.toml` with local paths, git urls with a tag, or version requirements looked up in a plain JSON index. `lumen.lock` records the exact commits. There is no solver: two packages that want different versions of a third each get their own copy.

## What was left out on purpose

Threads. The C collector scans one stack, and the four engines would need a sharing model they can all implement; message passing between isolated heaps is the only one that fits, and it has not been built.

TLS. `http_get` and `http_request` shell out to curl rather than carry a TLS stack.

A moving or incremental collector. The conservative one is simple and has held up under a mode that collects on every allocation (`LM_GC_STRESS=1`), which is run over the standard library examples in CI.

## Where to start reading

`src/ast.ts` and `src/types.ts` first, they are short. Then `src/analyzer.ts` for what the tree looks like after typing, and `src/interpreter.ts` for what each node means. The other backends are easiest to read next to the interpreter.
