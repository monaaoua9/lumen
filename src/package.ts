import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const MANIFEST = 'lumen.toml';

export interface Dep {
  name: string;
  spec: string;
  dir: string;
  git: boolean;
}

export function findManifest(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const p = join(dir, MANIFEST);
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// just enough toml: a [dependencies] table of `name = "path or git url"`
export function readDeps(manifest: string): Dep[] {
  const root = dirname(manifest);
  const deps: Dep[] = [];
  let inDeps = false;
  for (const raw of readFileSync(manifest, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      inDeps = line === '[dependencies]';
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"$/.exec(line);
    if (!inDeps || !m) continue;
    const git = /^(https?:\/\/|git@|ssh:\/\/)/.test(m[2]) || m[2].endsWith('.git');
    const dir = git ? join(root, '.lumen', 'deps', m[1]) : isAbsolute(m[2]) ? m[2] : resolve(root, m[2]);
    deps.push({ name: m[1], spec: m[2], dir, git });
  }
  return deps;
}

export function depsFor(entry: string): Map<string, string> {
  const manifest = findManifest(dirname(resolve(entry)));
  const map = new Map<string, string>();
  if (manifest) for (const d of readDeps(manifest)) map.set(d.name, d.dir);
  return map;
}

export function init(dir: string, name: string): string {
  const p = join(dir, MANIFEST);
  if (existsSync(p)) throw new Error(`${MANIFEST} already exists`);
  writeFileSync(p, `[package]\nname = "${name}"\n\n[dependencies]\n# colors = "../colors"\n# json5 = "https://github.com/someone/json5.git"\n`);
  return p;
}

// path deps need nothing; git deps are cloned once into .lumen/deps/<name>
export function install(manifest: string): string[] {
  const out: string[] = [];
  for (const d of readDeps(manifest)) {
    if (!d.git) {
      out.push(existsSync(d.dir) ? `${d.name}: ${d.dir}` : `${d.name}: missing directory ${d.dir}`);
      continue;
    }
    if (existsSync(d.dir)) {
      out.push(`${d.name}: already installed`);
      continue;
    }
    mkdirSync(dirname(d.dir), { recursive: true });
    const r = spawnSync('git', ['clone', '--depth', '1', '--', d.spec, d.dir], { stdio: 'inherit' });
    out.push(r.status === 0 ? `${d.name}: cloned` : `${d.name}: clone failed`);
  }
  return out;
}
