import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Diagnostic, Segment } from './diagnostics.ts';

export interface Bundle {
  text: string;
  segments: Segment[];
  diags: Diagnostic[];
}

interface Part {
  name: string;
  text: string;
  bad: { start: number; end: number; msg: string }[];
}

const IMPORT = /^[ \t]*import[ \t]+"([^"\n]*)"[ \t]*;?[ \t]*$/gm;

// `import "other.lum";` lines are resolved before lexing: every file is read once, dependencies come first,
// (the parser skips the import lines themselves)
export function bundle(entry: string): Bundle {
  const parts: Part[] = [];
  const seen = new Set<string>();

  const visit = (path: string) => {
    const abs = resolve(path);
    if (seen.has(abs)) return;
    seen.add(abs);
    const deps: string[] = [];
    const part: Part = { name: basename(abs), text: '', bad: [] };
    part.text = readFileSync(abs, 'utf8').replace(IMPORT, (m, rel: string, off: number) => {
      const target = resolve(dirname(abs), rel);
      if (existsSync(target)) deps.push(target);
      else part.bad.push({ start: off + m.indexOf('"'), end: off + m.lastIndexOf('"') + 1, msg: `cannot find module '${rel}'` });
      return m;
    });
    for (const d of deps) visit(d);
    parts.push(part);
  };
  visit(entry);

  const segments: Segment[] = [];
  const diags: Diagnostic[] = [];
  let text = '';
  for (const p of parts) {
    const start = text.length;
    segments.push({ name: p.name, start, end: start + p.text.length });
    for (const b of p.bad) {
      diags.push({ severity: 'error', code: 'P004', message: b.msg, span: { start: start + b.start, end: start + b.end } });
    }
    text += p.text + '\n';
  }
  return { text, segments, diags };
}
