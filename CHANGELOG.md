# Changelog

Newest first. The README has the full description of every feature.

## Language

- Default argument values, named arguments (`box(height: 5, width: 4)`), also on generic functions and methods, struct update `P { x: 1, ..base }`.
- `if let`, `while let`, `loop { }`, range patterns in `match` (`1..5`, `1..=9`).
- Destructuring lets (`let [a, b] = pair();`, `let P { x, y } = p;`) and multiple assignment (`a, b = b, a;`).
- `for i, x in xs`, `for ch in text`, slices `a[lo..hi]` and `s[lo..hi]`, open and inclusive ends (`a[1..]`, `a[..2]`, `a[2..=3]`), `s[i]` reads one character.
- `==` and `!=` on structs, `\x41` and `\u{1F600}` string escapes, `assert(cond)` quotes its condition.
- `print(a, b, c)` prints its values separated by spaces.
- Lambda parameter and return types are inferred where the expected type is known (`list.map(xs, fn(x) => x * x)`).
- An empty `[]` argument takes its type from the other arguments of a generic call (`map.get(g, n, [])`).
- Local functions can call themselves.
- A private struct or enum can be the type argument of a generic function from another file (no more E027 inside the library).
- Method-call syntax on any value: `xs.len()`, `s.trim().upper()`, `n.twice()` read as `len(xs)`, `upper(trim(s))`, `twice(n)`.
- Tuples: `(int, string)`, `(1, "a")`, `t.0`, `let (a, b) = t;`.
- `match` on tuples: `(0, _) => ...`, `(x, 0) => x`, literals, names and `_` as parts (`match (n % 3, n % 5)`).
- `for (a, b) in pairs` and `for i, (a, b) in xs` take tuples apart in the loop head.
- Nested tuple patterns (`let ((a, b), c) = t;`) and chained access (`t.0.1`).

## Builtins

- `args()`, `read_file(path)`, `write_file(path, text)`, `clock()`.
- Call depth is capped at 1000 on every engine, the interpreter runs on a big-stack thread to get there.

## Tools

- `lumen test` runs every `fn test_*()` in one or more files (`--only` filters), `lumen check` takes several files.
- REPL commands `:type`, `:reset`, `:help`.
- Differential tests compare random int, float, string and array programs across interp, vm, `-O` and C.
- The C backend prints the source position of the failing statement on traps.
- Runtime errors on the VM and interpreter print the chain of calling functions with their line numbers.

## Standard library

- New: `std/test`, `std/bits`, `std/random`, `std/set`, `std/json` (parser and printer).
- Extended: `std/list` (max_by, min_by, last, sum_by, zip, enumerate, partition, take_while, drop_while, chunks, sort_by, take, drop, zip_with, flatten, unique, ...), `std/text` (pad_left and pad_right default to spaces, trim_start, trim_end, split_once, lines, chars, center, fixed, ...), `std/set` (is_subset, equal), `std/random` (pick), `std/map` (keys, values, entries, from_entries, merge, update), `std/option` (and_then, unwrap_or_else, is_err, and_then_result, map_option, find_by, first, ...), `std/math` (mod_pow, fib, isqrt, factorial, ...).
