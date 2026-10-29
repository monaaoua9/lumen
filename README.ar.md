# Lumen

للتعلّم السريع ابدأ بـ [docs/tutorial.md](docs/tutorial.md) (أمثلته تُنفَّذ ضمن الاختبارات).

لغة برمجة صغيرة مُنمّطة ستاتيكياً، مع سلسلة الأدوات كاملة في مستودع واحد:
Lexer، Parser، محلل ثابت (Static Analyzer)، مفسّر (Interpreter)، مترجم إلى بايت كود مع آلة افتراضية (VM)، ومترجم إلى لغة C.
مكتوبة بـ TypeScript دون أي اعتماديات وقت التشغيل (Node 22.18 أو أحدث).

تدعم اللغة الآن المصفوفات أحادية البعد (`int[]` و`float[]` و`bool[]` و`string[]`) مع `push` و`pop` و`len` وفحص الحدود.

وتدعم الهياكل `struct` (تداخل، مصفوفات من الهياكل، طباعة تلقائية) بدلالات المراجع.

وتدعم الدوال المرتبطة بالأنواع عبر `impl` (مثل `c.tick()`). وتدعم `enum` مع `match` ويتحقق المحلل من شمولية الحالات (Exhaustiveness) ويعرض الحالات الناقصة. ويمكن للحالات حمل بيانات (`Circle(float)`) وتفكيكها داخل `match`. وتُكتب الأعداد أيضاً `0xFF` و`0b1010` و`1_000_000`، والتعليقات `//` و`/* */`. ويمكن أن تكون الكتلة قيمة: `let n = { let a = 20; a + 22 };` (آخر عنصر هو النتيجة). ويمكن إضافة شرط (guard) لأي حالة في `match`: `Circle(r) if r > 1.0 => ...`. ويمكن استعمال `if ... else ...` كتعبير يعيد قيمة (الفرعان مطلوبان). ويمكن وضع تعبيرات داخل النصوص: `"المجموع {a + b}"`.

والدوال قيم من الدرجة الأولى (`fn(int): int`)، مع دوال مجهولة تلتقط المتغيرات (closures تشارك المتغيرات القابلة للتعديل)، ودوال عامة (generics) بأنواع تُستنتج من النداء، ووحدات عبر `import "file.lum";`، ودوال رياضية مدمجة (`sqrt` و`floor` و`ceil` و`abs` و`min` و`max`)  و`read_line()` و`at_eof()` لقراءة المدخلات و`assert(cond, msg)` و`exit(code)` لإنهاء البرنامج برمز خروج ودوال مصفوفات (`sort` و`reverse` و`slice` و`contains` و`insert` و`remove`) ودوال نصوص (`substr` و`find` و`split` و`byte` و`chr` و`join` و`trim` و`upper` و`lower` و`replace` و`starts_with` و`ends_with` و`repeat` و`parse_int` و`parse_float`).

ومن الإضافات الأحدث: استنتاج أنواع وسائط الدوال المجهولة حيث يكون النوع المتوقع معروفاً (`list.map(xs, fn(x) => x * x)`)، وحلقة `for i, x in xs` مع الموضع، و`for ch in text` على أحرف النص، وقص المصفوفات والنصوص `a[1..3]` وقراءة حرف `s[i]`، وتفكيك القيم `let [a, b] = pair();` و`let P { x, y } = p;`، و`if let` و`while let`، ومقارنة الـ structs بـ `==`، ودوال محلية تستدعي نفسها، ودوال `args()` و`read_file(path)` و`write_file(path, text)`. وتدعم اللغة أيضاً قيم الـ tuples (`(int, string)` و`(1, "a")` و`t.0` و`let (a, b) = t;` و`for (a, b) in pairs`، وتتداخل: `let ((a, b), c) = t;`)، والقيم الافتراضية للمعاملات والوسائط المسمّاة (`box(height: 5, width: 4)`، وتعمل مع الدوال العامة وطرقها)، وتحديث الـ struct بـ `P { x: 1, ..base }`، و`loop { }`، والنطاقات في `match` (`1..5`)، والإسناد المتعدد `a, b = b, a;`، وصيغة الاستدعاء على أي قيمة (`xs.len()` و`s.trim().upper()` تعادل `len(xs)` و`upper(trim(s))`). ويشغّل `lumen test file.lum` كل دالة اسمها `test_...` في الملف، ويقبل `lumen check` عدة ملفات.

وكود C المولَّد يحمل جامع نفايات (Mark & Sweep) صغيراً يحرّر الذاكرة تلقائياً.

## المسار

```
الشفرة ─► Lexer ─► Parser ─► Analyzer ─┬─► Interpreter
                                       ├─► Compiler ─► Bytecode ─► VM
                                       └─► C codegen ─► gcc/clang ─► ملف تنفيذي
```

المحلل يضيف الأنواع والرموز على الـ AST نفسه، فتستهلك كل الأهداف شجرة واحدة مُنمّطة.
الأخطاء تمنع التنفيذ، والتحذيرات (lints) لا تمنعه.

## المكتبة القياسية

مجلد `lib/` فيه وحدات مكتوبة بلغة Lumen نفسها، تُستورد بالبادئة `std/`، مثل `import "std/map.lum"` الذي يوفر `Map<V>` بمفاتيح نصية مع `set` و`get` و`has` و`delete` و`size`. وفيها أيضاً `std/option.lum` (`Option<T>` و`Result<T>`) و`std/math.lum` (`gcd` و`lcm` و`pow` و`clamp` و`is_prime`) و`std/list.lum` (`map` و`filter` و`fold` و`any` و`all` و`range` و`sum` و`sort_by` و`take` و`drop` و`unique` وغيرها) و`std/text.lum` (`pad_left` و`pad_right` و`is_digits` و`is_alpha` و`reversed` و`count` و`words` و`lines` و`chars` و`fixed`). وأُضيف إلى `std/list` دوال `zip` و`enumerate` و`partition` و`take_while` و`drop_while` و`chunks` و`max_by` و`min_by`، وإلى `std/text` دوال `trim_start` و`trim_end` و`split_once`، وإلى `std/map` دوال `entries` و`from_entries` و`merge`، وإلى `std/option` دوال `and_then` و`unwrap_or_else`، وأُضيف `std/set` و`std/json` (محلل ومطبعة JSON مكتوبان بـ Lumen). وأُضيف أيضاً `std/test.lum` (دوال تحقق لـ `lumen test`) و`std/bits.lum` (عمليات بتّات) و`std/random.lum` (مولّد أرقام بنواة ثابتة).

## التشغيل

```
npm install
node src/cli.ts run examples/fib.lum
node src/cli.ts check examples/errors.lum
node src/cli.ts disasm examples/fib.lum
node src/cli.ts build examples/bench.lum -o bench
node src/cli.ts repl
node src/cli.ts explain E003
node src/cli.ts fmt --write file.lum
npm test
```

التفاصيل الكاملة (الدلالات، أكواد الأخطاء والتحذيرات، الحدود الحالية) في [README.md](README.md).

## الترخيص

MIT
