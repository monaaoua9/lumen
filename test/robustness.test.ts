import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { frontend } from '../src/pipeline.ts';

const PIECES = [
  'fn', 'struct', 'enum', 'match', 'let', 'var', 'if', 'else', 'while', 'return', 'break', 'continue',
  'x', 'y', 'P', 'Color', 'int', 'float', 'string', 'bool', '1', '2.5', '"s"', 'true', 'false', '_',
  '(', ')', '{', '}', '[', ']', ',', ';', ':', '=', '==', '=>', '|', '||', '&&', '.', '+', '-', '*', '/', '%', '<', '!', '+=',
];

// tiny deterministic PRNG so failures are reproducible
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

test('frontend never crashes or hangs on token soup', () => {
  const rand = rng(42);
  for (let n = 0; n < 3000; n++) {
    const len = 1 + Math.floor(rand() * 30);
    const src = Array.from({ length: len }, () => PIECES[Math.floor(rand() * PIECES.length)]).join(' ');
    try {
      frontend(src);
    } catch (e) {
      assert.fail(`crashed on: ${src}\n${e}`);
    }
  }
});

test('frontend survives truncated real programs', () => {
  const dir = new URL('../examples/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.lum'))) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    for (let cut = 0; cut < text.length; cut += 17) {
      try {
        frontend(text.slice(0, cut));
      } catch (e) {
        assert.fail(`crashed on ${f} cut at ${cut}\n${e}`);
      }
    }
  }
});

const cli = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8' });

test('cli: run, check and exit codes', () => {
  const ok = cli('run', 'examples/fib.lum');
  assert.equal(ok.status, 0);
  assert.ok(ok.stdout.includes('fib(15) = 610'));

  const bad = cli('check', 'examples/errors.lum');
  assert.equal(bad.status, 1);
  assert.ok(bad.stdout.includes('error[E003]'));

  const json = cli('check', 'examples/lints.lum', '--json');
  assert.equal(json.status, 0);
  assert.ok(Array.isArray(JSON.parse(json.stdout)));

  assert.equal(cli('check', 'examples/lints.lum', '--Werror').status, 1);
  assert.equal(cli('run', 'examples/overflow.lum').status, 1);
  assert.equal(cli().status, 0);
});
