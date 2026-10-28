# Lumen

لغة برمجة صغيرة مُنمّطة ستاتيكياً، مع سلسلة الأدوات كاملة في مستودع واحد:
Lexer، Parser، محلل ثابت (Static Analyzer)، مفسّر (Interpreter)، مترجم إلى بايت كود مع آلة افتراضية (VM)، ومترجم إلى لغة C.
مكتوبة بـ TypeScript دون أي اعتماديات وقت التشغيل (Node 22.18 أو أحدث).

تدعم اللغة الآن المصفوفات أحادية البعد (`int[]` و`float[]` و`bool[]` و`string[]`) مع `push` و`pop` و`len` وفحص الحدود.

وتدعم الهياكل `struct` (تداخل، مصفوفات من الهياكل، طباعة تلقائية) بدلالات المراجع.

وتدعم `enum` مع `match` ويتحقق المحلل من شمولية الحالات (Exhaustiveness) ويعرض الحالات الناقصة.

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
npm test
```

التفاصيل الكاملة (الدلالات، أكواد الأخطاء والتحذيرات، الحدود الحالية) في [README.md](README.md).

## الترخيص

MIT
