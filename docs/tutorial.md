# Lumen in ten minutes

Every example below is run by the test suite (`test/docs.test.ts`) and its output is compared with the block under it.
Run one yourself with `node src/cli.ts run file.lum`.

## 1. Values and functions

Types are written after the name. `let` is fixed, `var` can change. A function declares its parameter and return types; `print` takes any number of values.

```lum
fn area(w: int, h: int): int {
  return w * h;
}

let room = area(4, 5);
var total = 0;
for i in 0..3 {
  total += room * i;
}
print("room", room, "total", total);
```

```output
room 20 total 60
```

## 2. Strings and interpolation

Strings are UTF-8, `{expr}` inside a string is interpolated, and `s[i]` or `for ch in s` walk whole characters, so Arabic text works.

```lum
let name = "سارة";
print("hello {name}, {len(name)} bytes");
var n = 0;
for ch in name { n += 1; }
print("{n} characters, first is {name[0]}");
print("  padded ".trim().upper());
```

```output
hello سارة, 8 bytes
4 characters, first is س
PADDED
```

## 3. Arrays, slices and loops

Arrays are references. Slices copy and may leave either end open. Loops can be labelled so `break` and `continue` reach an outer loop.

```lum
let xs = [3, 1, 4, 1, 5, 9, 2, 6];
print(xs[2..5], xs[..2], xs[6..]);
sort(xs);
print(xs);

outer: for i in 0..3 {
  for j in 0..3 {
    if j == 2 { continue outer; }
    if i == 2 { break outer; }
    print("cell", i, j);
  }
}
```

```output
[4, 1, 5] [3, 1] [2, 6]
[1, 1, 2, 3, 4, 5, 6, 9]
cell 0 0
cell 0 1
cell 1 0
cell 1 1
```

## 4. Structs and methods

`impl` attaches functions to a struct. Any function can also be called with method syntax on its first argument.

```lum
struct Point { x: int, y: int }

impl Point {
  fn dist2(self, other: Point): int {
    let dx = self.x - other.x;
    let dy = self.y - other.y;
    return dx * dx + dy * dy;
  }
}

fn shifted(p: Point, by: int = 1): Point {
  return Point { x: p.x + by, ..p };
}

let a = Point { x: 0, y: 0 };
let b = shifted(a, by: 3);
print(a.dist2(b), b);
```

```output
9 Point { x: 3, y: 0 }
```

## 5. Enums and match

Variants can carry data. `match` must cover every case, and tuples can be matched too.

```lum
enum Shape { Circle(float), Rect(float, float), Dot }

fn area(s: Shape): float {
  return match s {
    Circle(r) => 3.0 * r * r,
    Rect(w, h) => w * h,
    Dot => 0.0,
  };
}

fn fizz(n: int): string {
  return match (n % 3, n % 5) {
    (0, 0) => "FizzBuzz",
    (0, _) => "Fizz",
    (_, 0) => "Buzz",
    _ => str(n),
  };
}

print(area(Shape.Rect(2.0, 4.5)), area(Shape.Dot));
for i in 1..6 { print(fizz(i * 3 - 1)); }
```

```output
9.0 0.0
2
Buzz
8
11
14
```

## 6. Tuples and destructuring

Tuples are written `(a, b)`, read with `.0`, and taken apart in `let` and `for`.

```lum
fn minmax(xs: int[]): (int, int) {
  var lo = xs[0];
  var hi = xs[0];
  for x in xs {
    lo = min(lo, x);
    hi = max(hi, x);
  }
  return (lo, hi);
}

let (lo, hi) = minmax([4, 8, 1, 9]);
print(lo, hi);
for (name, score) in [("a", 3), ("b", 5)] {
  print(name, score);
}
```

```output
1 9
a 3
b 5
```

## 7. Closures and generics

Functions are values and capture what they use. Generic functions are monomorphized, and parameter types of a lambda are inferred from where it is passed.

```lum
fn counter(): fn(): int {
  var n = 0;
  return fn(): int {
    n += 1;
    return n;
  };
}

fn apply_twice<T>(x: T, f: fn(T): T): T {
  return f(f(x));
}

let next = counter();
next();
print(next(), apply_twice(5, fn(n) => n * n));
```

```output
2 625
```

## 8. The standard library

`import "std/..."` brings a module in under its file name. After importing, library functions also work with method syntax.

```lum
import "std/list.lum"
import "std/map.lum"

let words = ["pear", "fig", "apple", "fig"];
let counts: map.Map<int> = map.new();
for w in words { map.update(counts, w, 0, fn(c) => c + 1); }
for (w, c) in map.entries(counts) { print(w, c); }
print(words.map(fn(w) => len(w)).sum());
```

```output
pear 1
fig 2
apple 1
15
```


## 9. Errors without exceptions

A function that can fail returns `Result<T>` (or `Option<T>`). `let n = try f();` unwraps the `Ok`; on an `Err` the enclosing function returns that error right away, so the happy path stays flat.

```lum
import "std/option.lum"

fn port(s: string): option.Result<int> {
  let n = parse_int(s, -1);
  if n < 1 || n > 65535 { return option.Result.Err("bad port " + s); }
  return option.Result.Ok(n);
}

fn address(host: string, p: string): option.Result<string> {
  let n = try port(p);
  return option.Result.Ok(host + ":" + str(n));
}

for p in ["8080", "99999"] {
  match address("localhost", p) {
    Ok(a) => { print(a); }
    Err(m) => { print("error:", m); }
  }
}
```

```output
localhost:8080
error: bad port 99999
```
