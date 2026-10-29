# Changelog

Newest first. The README has the full description of every feature.

## Language

- Default argument values, named arguments (`box(height: 5, width: 4)`), struct update `P { x: 1, ..base }`.
- `if let`, `while let`, `loop { }`, range patterns in `match` (`1..5`, `1..=9`).
- Destructuring lets (`let [a, b] = pair();`, `let P { x, y } = p;`) and multiple assignment (`a, b = b, a;`).
- `for i, x in xs`, `for ch in text`, slices `a[lo..hi]` and `s[lo..hi]`, `s[i]` reads one character.
- `==` and `!=` on structs, `\x41` and `\u{1F600}` string escapes, `assert(cond)` quotes its condition.
- Lambda parameter and return types are inferred where the expected type is known (`list.map(xs, fn(x) => x * x)`).
- Local functions can call themselves.
- Tuples: `(int, string)`, `(1, "a")`, `t.0`, `let (a, b) = t;`.
- `for (a, b) in pairs` and `for i, (a, b) in xs` take tuples apart in the loop head.
- Nested tuple patterns (`let ((a, b), c) = t;`) and chained access (`t.0.1`).

## Builtins

- `args()`, `read_file(path)`, `write_file(path, text)`, `clock()`.
- Call depth is capped at 1000 on every engine, the interpreter runs on a big-stack thread to get there.

## Tools

- `lumen test` runs every `fn test_*()` in one or more files (`--only` filters), `lumen check` takes several files.
- REPL commands `:type`, `:reset`, `:help`.
- Differential tests compare random int, float, string and array programs across interp, vm, `-O` and C.

## Standard library

- New: `std/test`, `std/bits`, `std/random`, `std/set`, `std/json` (parser and printer).
- Extended: `std/list` (zip, enumerate, partition, take_while, drop_while, chunks, sort_by, take, drop, zip_with, flatten, unique, ...), `std/text` (lines, chars, center, fixed, ...), `std/map` (keys, values, entries, update), `std/option` (map_option, find_by, first, ...), `std/math` (isqrt, factorial, ...).
