# Changelog

Newest first. The README has the full description of every feature.

## Unreleased

- `run` and `test` use the js engine by default instead of the VM (`--engine vm` still works).
- Language server: completion and document symbols.
- `lumen debug file.lum`: breakpoints by line, step, next, continue, print, locals, bt, list.
- Packages: version requirements (`^1.2`, `~1.2`, `1.2.3`) resolved through a package index, `LUMEN_REGISTRY`.

## 1.3.0

- `--engine js`: a fourth backend that turns the program into JavaScript and lets V8 compile it, around 4x faster than the VM; `lumen emit-js` prints the generated code.

## 1.2.0

- `http_request(method, url, headers, body)`.
- Packages: `#ref` on git dependencies, `lumen.lock`, `lumen update`, dependencies of dependencies.
- Native builds: string variables that are only appended to grow in place, `s += x` in a loop is no longer quadratic.

## 1.1.0

- File and environment builtins: `append_file`, `file_exists`, `list_dir`, `remove_file`, `env`.
- `http_get(url)`, through curl.
- Packages: `lumen.toml`, `lumen init`, `lumen install`, `import "name/file.lum"` for dependencies.
- The call depth cap is 10000 instead of 1000 on every engine; native builds on Windows get a 64MB stack.

## 1.0.0

First stable release: everything below is part of it.

## Language

- Explicit type arguments on generic calls: `zero<int>()`, `map.new<string>()`.
- std/json readers: `field`, `at`, `size`, `as_str`, `as_num`, `as_int`, `as_bool`.
- std/regex groups: `(...)`, `(?:...)`, alternation and quantifiers on groups, and `regex.captures`.
- `let r: int = loop { ... break value; }`: a loop that gives a value (the variable's type must be written).
- `lumen lsp`: a language server over stdio with live diagnostics, hover, go to definition and formatting.
- `match (a, b) { (Red, true) => ... }`: variants (with bindings, literals, nesting) may appear as the parts of a tuple pattern. A capitalised name inside a tuple pattern used to bind silently; inside a variant's payload tuple it is now a P001 error.
- Bitwise operators on ints: `&`, `|`, `^`, `<<`, `>>`, `~`, on every engine and in `-O` folding.
- Names may be written with any letters, Arabic included (`struct طالب { اسم: string }`).
- Arms like `Wrap(Some(n))` and `Wrap(None)` together count as covering `Wrap`, so the match no longer needs a `_` arm (plain bindings only; several nested variants in one arm are checked together, like `Pair(Some(a), None)`).
- Default argument values, named arguments (`box(height: 5, width: 4)`), also on generic functions and methods, struct update `P { x: 1, ..base }`.
- `if let`, `while let`, `loop { }`, range patterns in `match` (`1..5`, `1..=9`).
- `let x = try e;` unwraps an `Ok` / `Some` and otherwise returns the `Err` / `None` from the enclosing function (a P001 error outside a `Result` / `Option` function).
- `try e;` as a statement: same early return, the unwrapped value is dropped.
- `try` also works inside a function value that is declared to return a `Result` or an `Option`.
- Structs may have no fields (`struct Len { }`), handy as carriers for trait impls; they print as `Len {}`.
- `const NAME = value;` declares an immutable binding (a `let` under another name).
- A guard on a tuple pattern may read the names the pattern binds (`(x, 0) if x > 3 =>`).
- Tuple pattern alternatives can bind names: `(x, 0) | (0, x) => x`, as long as each alternative binds the same ones.
- `lumen` starts about 100 ms faster: the entry file turns on the V8 compile cache before loading the compiler.
- New std/matrix: `new`, `identity`, `transpose`, `add`, `mul`, `pow`.
- std/text: `wrap`, `glob`, `ord` (code point of a character).
- The test suite now builds every examples/std program in C and checks it again with a collection on every allocation.
- New std/regex: `is_match`, `full_match`, `search`, `all_matches`, `pieces`, `sub` over a small pattern syntax (classes, `* + ? {n,m}`, anchors, `|`).
- Expressions thousands of terms long (or levels deep) no longer overflow the compiler's stack: the command restarts on a thread with a 256 MB stack. A C compiler that fails without printing anything now gets an error line.
- `chr(n)` builds any Unicode code point (UTF-8), it used to stop at 127; std/json decodes \uXXXX escapes and surrogate pairs.
- Tuples inside variant patterns: `Some((i, name))`, `Hit((0, _))`.
- Nested variant patterns: `Wrap(Some(n))`, `Bin(Add, x, y)`, also in `if let` and `while let` (these now accept the same literal and range forms as `match`).
- A generic struct literal can name its type arguments: `Stack<int> { items: [] }`.
- Literal parts in variant patterns: `Num(0)`, `Op("+") | Op("-")`, `Pair(0, y) if y > 3`.
- Statement `match` arms may be a bare expression: `Ok(b) => print(b),`.
- `return` inside a block expression now leaves the function (it used to be E029, which is gone).
- `let (a, b) = try e;` works too: the destructuring happens after the unwrap.
- std/math: `lerp`, `hypot`, `fpow`; std/text: `truncate`, `title`.
- std/list: `product`, `rotate`, `count_by`.
- New std/format: `commas`, `table`, `percent`.
- std/format: `table` no longer traps when a row ends with a non-ASCII character.
- std/text: `capitalize` and `title` no longer trap on text that starts with a multi-byte character.
- std/path: `basename`, `dirname` and `ext` no longer trap on non-ASCII names.
- New std/date: calendar arithmetic (`to_days`, `from_days`, `weekday`, `add_days`, `iso`).
- New std/encoding: `to_hex`, `from_hex`, `hex_encode`, `base64_encode`.
- A generic function nobody calls still gets its undeclared names reported (E001), the rest of its body is checked once it is called.
- `try` works directly inside a block expression: `let v = { let h = try half(n); h + 1 };` leaves the function with the `Err` / `None` like anywhere else.
- Runtime errors in the C backend print the same call trace as the interpreter and the VM.
- Generic enums (`option.Result<Task>`) can carry a struct that the program itself declares, also when the struct is not `pub`.
- Same for generic structs: `map.Map<Item>` with a private `Item` no longer reports E027.
- The E024 hint writes out the type to annotate (`let x: Queue<int> = ...`) instead of a placeholder.
- C backend: `len(s)`, `byte` and `substr` no longer rescan a long string on every call (parsing a 600 KB JSON text took 40 s, now 1.5 s).
- `lumen --version` (also `-v`); the `cli.ts` entry has its shebang back.
- `-e CODE` works with every command that reads a file (ast, disasm, emit-c, bench, test), not only run and check.
- `editors/vscode`: a TextMate grammar and language configuration for `.lum` files.
- A `pub` function of an imported file is no longer reported as never called.
- `lumen test` files for std/format, std/text extras, std/date, std/matrix and std/encoding, run in CI.
- Generic enums and structs may mention themselves (`enum Tree<T> { Leaf, Node(Tree<T>, T, Tree<T>) }`, `struct Node<T> { kids: Node<T>[] }`); the first form used to report E016.
- Labelled loops: `outer: for ... { for ... { break outer; } }` and `continue outer;`.
- Destructuring lets (`let [a, b] = pair();`, `let P { x, y } = p;`) and multiple assignment (`a, b = b, a;`).
- `for i, x in xs`, `for ch in text`, slices `a[lo..hi]` and `s[lo..hi]`, open and inclusive ends (`a[1..]`, `a[..2]`, `a[2..=3]`), `s[i]` reads one character.
- `for ch in text` and `s[i]` work on whole UTF-8 characters (`s[i]` reads the character that starts at byte i), so Arabic and other non-ASCII text no longer traps.
- `==` and `!=` on structs, `\x41` and `\u{1F600}` string escapes, `assert(cond)` quotes its condition.
- Float literals take an exponent: `1e9`, `2.5e-5`.
- `int(Color.Blue)` gives the position of a variant in an enum without data.
- `print(a, b, c)` prints its values separated by spaces.
- Lambda parameter and return types are inferred where the expected type is known (`list.map(xs, fn(x) => x * x)`).
- An empty `[]` argument takes its type from the other arguments of a generic call (`map.get(g, n, [])`).
- Local functions can call themselves, and read the enclosing function's locals (copied in when the function is defined).
- A recursive local function inside a generic function that reads its locals is the clear error E031 (the real function is shared by every instance).
- A private struct or enum can be the type argument of a generic function from another file (no more E027 inside the library).
- Method-call syntax on any value: `xs.len()`, `s.trim().upper()`, `n.twice()` read as `len(xs)`, `upper(trim(s))`, `twice(n)`.
- The same works for generic functions and library functions: `xs.map(fn(x) => x * 2)`, `xs.chunks(2)`, `p.area()`.
- Tuples: `(int, string)`, `(1, "a")`, `t.0`, `let (a, b) = t;`.
- Diagnostics and `:type` show tuple types as `(int, string)`.
- `match` on tuples: `(0, _) => ...`, `(x, 0) => x`, literals, names and `_` as parts (`match (n % 3, n % 5)`).
- `for (a, b) in pairs` and `for i, (a, b) in xs` take tuples apart in the loop head.
- Nested tuple patterns (`let ((a, b), c) = t;`) and chained access (`t.0.1`).

## Builtins

- `args()`, `read_file(path)`, `write_file(path, text)`, `clock()`.
- Call depth is capped at 1000 on every engine, the interpreter runs on a big-stack thread to get there.

## Tools

- `docs/tutorial.md` and `docs/tutorial.ar.md`: a short tour (English and Arabic) whose examples are run by `test/docs.test.ts`.
- `lumen test` runs every `fn test_*()` in one or more files (`--only` filters), `lumen check` takes several files.
- A failing `lumen test` case shows the file, line and column of the assertion (or of the call inside the test that failed).
- REPL commands `:type`, `:reset`, `:help`.
- `lumen run -e 'print(1 + 2);'` runs code from the command line (also `check -e`).
- Differential tests compare random int, float, string, array and tuple-pattern/slice programs across interp, vm, `-O` and C.
- Scanning a long string by index or `for ch in s` is linear now (the bytes of the last string are cached), it used to copy the whole string on every access.
- The C backend prints the source position of the failing statement on traps.
- Runtime errors on the VM and interpreter print the chain of calling functions with their line numbers.

## Standard library

- New: `std/queue`, `std/heap` (priority queue), `std/stats`, `std/path`, `std/csv`, `std/test`, `std/bits`, `std/random`, `std/set`, `std/json` (parser and printer).
- `std/map` and `std/set` look keys up through a hash index instead of scanning, and keep insertion order.
- Extended: `std/list` (windows, group_by, max_by, min_by, last, sum_by, zip, enumerate, partition, take_while, drop_while, chunks, sort_by, take, drop, zip_with, flatten, unique, ...), `std/text` (char_count, pad_left and pad_right count characters and default to spaces, trim_start, trim_end, split_once, lines, chars, center, fixed, ...), `std/set` (is_subset, equal), `std/random` (pick), `std/map` (keys, values, entries, from_entries, merge, update), `std/option` (and_then, unwrap_or_else, is_err, and_then_result, map_option, find_by, first, ...), `std/math` (mod_pow, fib, isqrt, factorial, ...).
