import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const MANIFEST = 'lumen.toml';
export const LOCKFILE = 'lumen.lock';

export interface Dep {
  name: string;
  spec: string;
  url: string;
  ref: string;
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

// just enough toml: a [dependencies] table of `name = "path"` or `name = "git url#tag-or-commit"`
export function readDeps(manifest: string): Dep[] {
  const root = dirname(manifest);
  const deps: Dep[] = [];
  let inDeps = false;
  for (const raw of readFileSync(manifest, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#[^"]*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      inDeps = line === '[dependencies]';
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"$/.exec(line);
    if (!inDeps || !m) continue;
    const spec = m[2];
    const git = /^(https?:\/\/|git@|ssh:\/\/)/.test(spec) || /\.git(#|$)/.test(spec);
    const hash = git ? spec.indexOf('#') : -1;
    const url = hash >= 0 ? spec.slice(0, hash) : spec;
    const ref = hash >= 0 ? spec.slice(hash + 1) : '';
    const dir = git ? join(root, '.lumen', 'deps', m[1]) : isAbsolute(spec) ? spec : resolve(root, spec);
    deps.push({ name: m[1], spec, url, ref, dir, git });
  }
  return deps;
}

const manifests = new Map<string, Map<string, string>>();

// the packages visible from one source file: the nearest lumen.toml above it decides
export function depsFor(file: string): Map<string, string> {
  const manifest = findManifest(dirname(resolve(file)));
  if (!manifest) return new Map();
  let map = manifests.get(manifest);
  if (!map) {
    map = new Map(readDeps(manifest).map(d => [d.name, d.dir]));
    manifests.set(manifest, map);
  }
  return map;
}

export function init(dir: string, name: string): string {
  const p = join(dir, MANIFEST);
  if (existsSync(p)) throw new Error(`${MANIFEST} already exists`);
  writeFileSync(p, `[package]\nname = "${name}"\n\n[dependencies]\n# colors = "../colors"\n# json5 = "https://github.com/someone/json5.git#v1.2.0"\n`);
  return p;
}

type Lock = Map<string, { spec: string; commit: string }>;

function readLock(file: string): Lock {
  const lock: Lock = new Map();
  if (!existsSync(file)) return lock;
  let cur: { name?: string; spec?: string; commit?: string } = {};
  const flush = () => {
    if (cur.name && cur.spec && cur.commit) lock.set(cur.name, { spec: cur.spec, commit: cur.commit });
    cur = {};
  };
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '[[package]]') {
      flush();
      continue;
    }
    const m = /^(name|spec|commit)\s*=\s*"([^"]*)"$/.exec(line.trim());
    if (m) cur[m[1] as 'name' | 'spec' | 'commit'] = m[2];
  }
  flush();
  return lock;
}

function writeLock(file: string, lock: Lock) {
  const names = [...lock.keys()].sort();
  const body = names.map(n => `[[package]]\nname = "${n}"\nspec = "${lock.get(n)!.spec}"\ncommit = "${lock.get(n)!.commit}"\n`).join('\n');
  if (names.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, '# written by lumen install, commit it so everyone gets the same code\n\n' + body);
}

const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });

// path deps need nothing; git deps are cloned into .lumen/deps/<name> at the commit the lockfile names
// (or at the ref in the manifest the first time), then their own dependencies are installed the same way
export function install(manifest: string, only?: string): string[] {
  const out: string[] = [];
  const lockFile = join(dirname(manifest), LOCKFILE);
  const lock = readLock(lockFile);
  const seen = new Set<string>();

  const walk = (mf: string, prefix: string) => {
    for (const d of readDeps(mf)) {
      const id = prefix + d.name;
      if (!d.git) {
        out.push(existsSync(d.dir) ? `${id}: ${d.dir}` : `${id}: missing directory ${d.dir}`);
        const sub = join(d.dir, MANIFEST);
        if (existsSync(sub) && !seen.has(sub)) {
          seen.add(sub);
          walk(sub, id + '/');
        }
        continue;
      }
      if (only && prefix === '' && d.name !== only) continue;
      const locked = lock.get(id);
      const valid = locked && locked.spec === d.spec;
      if (!existsSync(d.dir)) {
        mkdirSync(dirname(d.dir), { recursive: true });
        const c = spawnSync('git', ['clone', '-q', '--', d.url, d.dir], { stdio: 'inherit' });
        if (c.status !== 0) {
          out.push(`${id}: clone failed`);
          continue;
        }
        const want = valid ? locked.commit : d.ref;
        if (want) {
          const co = git(d.dir, 'checkout', '-q', want);
          if (co.status !== 0) {
            out.push(`${id}: cannot check out ${want}`);
            continue;
          }
        }
        out.push(`${id}: cloned`);
      } else if (!valid && d.ref && git(d.dir, 'checkout', '-q', d.ref).status === 0) {
        out.push(`${id}: moved to ${d.ref}`);
      } else {
        out.push(`${id}: already installed`);
      }
      const head = git(d.dir, 'rev-parse', 'HEAD').stdout.trim();
      if (valid && head && head !== locked.commit) out.push(`${id}: checked out ${head.slice(0, 8)} but the lockfile says ${locked.commit.slice(0, 8)} (lumen update ${d.name} resets it)`);
      else if (head) lock.set(id, { spec: d.spec, commit: head });
      const sub = join(d.dir, MANIFEST);
      if (existsSync(sub) && !seen.has(sub)) {
        seen.add(sub);
        walk(sub, id + '/');
      }
    }
  };
  walk(manifest, '');
  writeLock(lockFile, lock);
  return out;
}

// forget the clone and its lock entry, then fetch it again from the manifest's ref
export function update(manifest: string, name?: string): string[] {
  const root = dirname(manifest);
  const lockFile = join(root, LOCKFILE);
  const lock = readLock(lockFile);
  for (const d of readDeps(manifest)) {
    if (!d.git || (name && d.name !== name)) continue;
    rmSync(d.dir, { recursive: true, force: true });
    for (const k of [...lock.keys()]) if (k === d.name || k.startsWith(d.name + '/')) lock.delete(k);
  }
  writeLock(lockFile, lock);
  return install(manifest);
}
