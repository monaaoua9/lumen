import { checked, frontend, execute } from '../src/pipeline.ts';
import type { Engine } from '../src/pipeline.ts';

export function diagCodes(src: string): string[] {
  return frontend(src).diagnostics.map(d => d.code);
}

export function runSrc(src: string, engine: Engine, opt = false): string {
  const fe = checked(src, 't.lum', opt);
  let out = '';
  execute(fe, engine, { out: s => { out += s; } });
  return out;
}

// every backend that runs in-process must agree
export const ENGINES: [Engine, boolean][] = [['interp', false], ['vm', false], ['interp', true], ['vm', true]];
