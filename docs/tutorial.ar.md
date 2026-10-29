# لغة Lumen في عشر دقائق

كل مثال أدناه تشغّله اختبارات المشروع (`test/docs.test.ts`) ويُقارَن ناتجه بالكتلة التي تحته. شغّل أي مثال بنفسك بـ `node src/cli.ts run file.lum`.

## 1. القيم والدوال

الأنواع تُكتب بعد الاسم. `let` ثابتة و`var` قابلة للتغيير. الدالة تعلن أنواع معاملاتها وقيمة الإرجاع، و`print` تقبل أي عدد من القيم.

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

للأعداد الصحيحة عوامل بتّية: `&` و`|` و`^` و`<<` و`>>` و`~`، بنفس أولويات Rust (`&` أقوى من `==`، والإزاحة أضعف من `+`). عدد إزاحة خارج 0..62 يوقف البرنامج، والإزاحة التي تتجاوز المدى تفشل مثل أي تجاوز للأعداد.

```lum
var perm = 1 | 4;
print(perm, (perm & 2) != 0, 1 << 10, -16 >> 2, ~5);
```

```output
5 false 1024 -4 -6
```

## 2. النصوص والاستيفاء

النصوص UTF-8، والتعبير داخل `{}` يُستوفى في النص، و`s[i]` و`for ch in s` تمشيان على حرف كامل فيعمل النص العربي.

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

## 3. المصفوفات والشرائح والحلقات

المصفوفات مراجع. الشرائح تنسخ ويمكن ترك أي طرف مفتوحاً. ويمكن تسمية الحلقات ليصل `break` و`continue` إلى الحلقة الخارجية.

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

## 4. الهياكل والدوال المرتبطة

`impl` يربط دوالاً بالـ struct. وأي دالة يمكن استدعاؤها بصيغة الدالة المرتبطة على أول معامل.

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

## 5. التعدادات و match

حالات التعداد قد تحمل بيانات، و`match` يجب أن تغطي كل الحالات، ويمكن مطابقة الـ tuples أيضاً.

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

وأجزاء الحالة قد تكون قيماً حرفية، ولا تحتاج الذراع في `match` كجملة إلى أقواس إذا كانت تعبيراً واحداً.

```lum
enum Cmd { Move(int), Say(string), Stop }

fn run(c: Cmd) {
  match c {
    Move(0) => print("standing still"),
    Move(n) if n < 0 => print("back", -n),
    Move(n) => print("forward", n),
    Say("hi") | Say("hello") => print("greeting"),
    Say(w) => print("says", w),
    Stop => print("stop"),
  }
}

run(Cmd.Move(0));
run(Cmd.Move(-2));
run(Cmd.Say("hello"));
run(Cmd.Say("bye"));
```

```output
standing still
back 2
greeting
says bye
```

## 6. الـ Tuples والتفكيك

الـ tuple تُكتب `(a, b)` وتُقرأ بـ `.0` وتُفكّك في `let` و`for`.

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

## 7. الإغلاقات والدوال العامة

الدوال قيم وتلتقط ما تستعمله. الدوال العامة تُولَّد لكل نوع، وأنواع معاملات الدالة المجهولة تُستنتج من مكان تمريرها.

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

## 8. المكتبة القياسية

`import "std/..."` يجلب وحدة باسم ملفها. بعد الاستيراد تعمل دوال المكتبة أيضاً بصيغة الاستدعاء على القيمة.

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

أنماط النصوص في `std/regex.lum`: النقطة والأصناف و`\d \w \s` و`* + ? {n,m}` والمراسي و`|` والمجموعات `(ab)+` مع `captures`. تُكتب الشرطة المائلة مضاعفة داخل النص، والقوس الحرفي `\{`.

```lum
import "std/regex.lum"

let line = "order 66 shipped on 2024-03-05, order 7 pending";
print(regex.all_matches("order \\d+", line));
print(regex.sub("\\d\{4}-\\d\{2}-\\d\{2}", line, "<date>"));
print(regex.is_match("^order", line), regex.full_match("[a-z]+", line));
```

```output
["order 66", "order 7"]
order 66 shipped on <date>, order 7 pending
true false
```


## 9. الأخطاء بدون استثناءات

الدالة التي قد تفشل تُرجع `Result<T>` (أو `Option<T>`). السطر `let n = try f();` يفكّ الـ `Ok`، وإذا كانت النتيجة `Err` ترجع الدالة المحيطة هذا الخطأ فوراً، فيبقى مسار النجاح مسطّحاً.

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
