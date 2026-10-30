# Benchmarks

Wall time of one run, median of 3, with the cost of an empty program on the same engine taken off
(node start-up and parsing; the C column times the compiled executable itself, the compile is not counted).
Every engine printed the same output for every program.

| program | interp | vm | js | c | js vs vm |
|---|---|---|---|---|---|
| fib | 1.22 s | 293 ms | 94 ms | 24 ms | 3.1x |
| loop | 1.11 s | 851 ms | 64 ms | 17 ms | 13.3x |
| sieve | 5.84 s | 4.06 s | 305 ms | 97 ms | 13.3x |
| sort | 575 ms | 406 ms | 330 ms | 61 ms | 1.2x |
| strings | 318 ms | 241 ms | 260 ms | 35 ms | 0.9x |
| structs | 1.10 s | 800 ms | 177 ms | 153 ms | 4.5x |

Machine: Intel(R) Core(TM) i5-8365U CPU @ 1.60GHz, 8 threads, win32 10.0.26200, node v24.15.0, gcc (MinGW-W64 x86_64-ucrt-posix-seh, built by Brecht Sanders, r3) 16.2.0.

Regenerate with `node benchmarks/run.ts`. The numbers move with the machine, compare the columns with each other
rather than with someone else's table.
