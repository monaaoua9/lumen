import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// every ```lum block in a tutorial is followed by an ```output block with what it prints
const files = ['tutorial.md', 'tutorial.ar.md'];

for (const name of files) {
  const doc = readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const pairs = [...doc.matchAll(/```lum\n([\s\S]*?)```\n\n```output\n([\s\S]*?)```/g)];

  test(`${name} has examples`, () => {
    assert.ok(pairs.length >= 8, `found ${pairs.length}`);
  });

  test(`${name} examples print what the page says`, () => {
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
}
