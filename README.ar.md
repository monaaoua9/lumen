# Lumen

لغة برمجة صغيرة مُنمّطة ستاتيكياً، مع سلسلة الأدوات كاملة في مستودع واحد:
Lexer، Parser، محلل ثابت (Static Analyzer)، مفسّر (Interpreter)، مترجم إلى بايت كود مع آلة افتراضية (VM)، ومترجم إلى لغة C.
مكتوبة بـ TypeScript دون أي اعتماديات وقت التشغيل (Node 22.18 أو أحدث).

تدعم اللغة الآن المصفوفات أحادية البعد (`int[]` و`float[]` و`bool[]` و`string[]`) مع `push` و`pop` و`len` وفحص الحدود.

وتدعم الهياكل `struct` (تداخل، مصفوفات من الهياكل، طباعة تلقائية) بدلالات المراجع.

وتدعم الدوال المرتبطة بالأنواع عبر `impl` (مثل `c.tick()`). وتدعم `enum` مع `match` ويتحقق المحلل من شمولية الحالات (Exhaustiveness) ويعرض الحالات الناقصة. ويمكن للحالات حمل بيانات (`Circle(float)`) وتفكيكها داخل `match`. ويمكن استعمال `if ... else ...` كتعبير يعيد قيمة (الفرعان مطلوبان). ويمكن وضع تعبيرات داخل النصوص: `"المجموع {a + b}"`.

والدوال قيم من الدرجة الأولى (`fn(int): int`)، مع دوال مجهولة تلتقط المتغيرات (closures تشارك المتغيرات القابلة للتعديل)، ودوال عامة (generics) بأنواع تُستنتج من النداء، ووحدات عبر `import "file.lum";`، ودوال رياضية مدمجة (`sqrt` و`floor` و`ceil` و`abs` و`min` و`max`)  و`read_line()` و`at_eof()` لقراءة المدخلات و`assert(cond, msg)` و`exit(code)` لإنهاء البرنامج برمز خروج ودوال مصفوفات (`sort` و`reverse` و`slice` و`contains` و`insert` و`remove`) ودوال نصوص (`substr` و`find` و`split` و`byte` و`chr` و`join` و`trim`).

وكود C المولَّد يحمل جامع نفايات (Mark & Sweep) صغيراً يحرّر الذاكرة تلقائياً.

## المسار

```
الشفرة ─► Lexer ─► Parser ─► Analyzer ─┬─► Interpreter
                                       ├─► Compiler ─► Bytecode ─► VM
                                       └─► C codegen ─► gcc/clang ─► ملف تنفيذي
```

المحلل يضيف الأنواع والرموز على الـ AST نفسه، فتستهلك كل الأهداف شجرة واحدة مُنمّطة.
الأخطاء تمنع التنفيذ، والتحذيرات (lints) لا تمنعه.

## التشغيل

```
npm install
node src/cli.ts run examples/fib.lum
node src/cli.ts check examples/errors.lum
node src/cli.ts disasm examples/fib.lum
node src/cli.ts build examples/bench.lum -o bench
node src/cli.ts repl
node src/cli.ts explain E003
npm test
```

التفاصيل الكاملة (الدلالات، أكواد الأخطاء والتحذيرات، الحدود الحالية) في [README.md](README.md).

## الترخيص

MIT
