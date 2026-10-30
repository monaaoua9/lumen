// node benchmarks/run.ts            runs every benchmarks/*.lum on each engine, writes benchmarks/RESULTS.md
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cli = join(here, '..', 'src', 'cli.ts');
const engines = ['interp', 'vm', 'js', 'c'] as const;
const runs = 3;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function time(cmd: string, args: string[]): { ms: number; out: string } {
  const t = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`);
  return { ms, out: r.stdout.replace(/\r\n/g, '\n') };
}

const tmp = mkdtempSync(join(tmpdir(), 'lumen-bench-'));
const hello = join(tmp, 'hello.lum');
writeFileSync(hello, 'print(1);\n');

// the C build is compiled once per program, only the run of the executable is timed
function runner(file: string, engine: (typeof engines)[number]): () => { ms: number; out: string } {
  if (engine !== 'c') return () => time(process.execPath, [cli, 'run', file, '--engine', engine]);
  const exe = join(tmp, 'prog' + (platform() === 'win32' ? '.exe' : ''));
  const b = spawnSync(process.execPath, [cli, 'build', file, '-o', exe], { encoding: 'utf8' });
  if (b.status !== 0) throw new Error(b.stderr);
  return () => time(exe, []);
}

// what an empty program costs on the same engine (node startup, parsing, thread setup), taken off the result
const startup = new Map<string, number>();
for (const e of engines) {
  const r = runner(hello, e);
  startup.set(e, e === 'c' ? 0 : median(Array.from({ length: runs }, () => r().ms)));
}

const programs = readdirSync(here).filter(f => f.endsWith('.lum')).sort();
const rows: string[] = [];
const results: Record<string, Record<string, number>> = {};
for (const p of programs) {
  const file = join(here, p);
  let reference: string | undefined;
  results[p] = {};
  for (const e of engines) {
    const r = runner(file, e);
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const x = r();
      reference ??= x.out;
      if (x.out !== reference) throw new Error(`${p}: ${e} printed something different`);
      samples.push(x.ms);
    }
    results[p][e] = Math.max(1, median(samples) - startup.get(e)!);
  }
  process.stdout.write(`${p} done\n`);
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
rows.push(`| program | ${engines.join(' | ')} | js vs vm |`);
rows.push(`|---|${engines.map(() => '---').join('|')}|---|`);
for (const p of programs) {
  const r = results[p];
  rows.push(`| ${p.replace('.lum', '')} | ${engines.map(e => fmt(r[e])).join(' | ')} | ${(r.vm / r.js).toFixed(1)}x |`);
}

const gcc = spawnSync('gcc', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0] || 'none';
const md = `# Benchmarks

Wall time of one run, median of ${runs}, with the cost of an empty program on the same engine taken off
(node start-up and parsing; the C column times the compiled executable itself, the compile is not counted).
Every engine printed the same output for every program.

${rows.join('\n')}

Machine: ${cpus()[0].model.trim()}, ${cpus().length} threads, ${platform()} ${release()}, node ${process.version}, ${gcc}.

Regenerate with \`node benchmarks/run.ts\`. The numbers move with the machine, compare the columns with each other
rather than with someone else's table.
`;
writeFileSync(join(here, 'RESULTS.md'), md);
rmSync(tmp, { recursive: true, force: true });
process.stdout.write('\n' + md);
