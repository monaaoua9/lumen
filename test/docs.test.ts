import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// every ```lum block in the tutorial is followed by an ```output block with what it prints
const doc = readFileSync(new URL('../docs/tutorial.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pairs = [...doc.matchAll(/```lum\n([\s\S]*?)```\n\n```output\n([\s\S]*?)```/g)];

test('the tutorial has examples', () => {
  assert.ok(pairs.length >= 8, `found ${pairs.length}`);
});

test('tutorial examples print what the tutorial says', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-doc-'));
  try {
    pairs.forEach(([, code, want], i) => {
      const file = join(dir, `ex${i}.lum`);
      writeFileSync(file, code);
      const r = spawnSync(process.execPath, ['src/cli.ts', 'run', file], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${code}\n${r.stderr}`);
      assert.equal(r.stdout.replace(/\r\n/g, '\n'), want, code);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
