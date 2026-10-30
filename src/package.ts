import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { httpGet } from './runtime.ts';

export const MANIFEST = 'lumen.toml';
export const LOCKFILE = 'lumen.lock';

// a package index is one json file: { "packages": { "name": { "git": "url", "versions": ["1.0.0", ...] } } },
// a version is the git tag v<version>. LUMEN_REGISTRY points somewhere else (a file:// url works too)
export const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/monaaoua9/lumen/main/registry/index.json';

export interface Dep {
  name: string;
  spec: string;
  url: string;
  ref: string;
  dir: string;
  git: boolean;
  registry: boolean; // spec is a version requirement, url and ref come from the index
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

const REQ = /^[\^~]?\d+(\.\d+){0,2}$|^\*$/;

// just enough toml: a [dependencies] table of `name = "path"`, `name = "git url#tag-or-commit"` or `name = "^1.2"`
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
    const registry = REQ.test(spec);
    const git = registry || /^(https?:\/\/|git@|ssh:\/\/)/.test(spec) || /\.git(#|$)/.test(spec);
    const hash = git && !registry ? spec.indexOf('#') : -1;
    const url = registry ? '' : hash >= 0 ? spec.slice(0, hash) : spec;
    const ref = hash >= 0 ? spec.slice(hash + 1) : '';
    const dir = git ? join(root, '.lumen', 'deps', m[1]) : isAbsolute(spec) ? spec : resolve(root, spec);
    deps.push({ name: m[1], spec, url, ref, dir, git, registry });
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
  writeFileSync(p, `[package]\nname = "${name}"\n\n[dependencies]\n# colors = "../colors"\n# json5 = "https://github.com/someone/json5.git#v1.2.0"\n# lumen-colors = "^1.2"   # from the package index\n`);
  return p;
}

// ---- versions

const parts = (v: string) => v.split('.').map(Number);

export function cmpVersion(a: string, b: string): number {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// "1.2.3" exactly that, "^1.2" same major and at least 1.2, "~1.2" same major.minor and at least 1.2, "*" anything
export function satisfies(version: string, req: string): boolean {
  if (req === '*') return true;
  const op = req[0] === '^' || req[0] === '~' ? req[0] : '';
  const want = parts(op ? req.slice(1) : req);
  const have = parts(version);
  if (!op) return want.every((n, i) => have[i] === n);
  if (cmpVersion(version, want.join('.')) < 0) return false;
  if (op === '^') return want[0] > 0 ? have[0] === want[0] : have[0] === 0 && (want[1] === undefined || have[1] === want[1]);
  return have[0] === want[0] && (want[1] === undefined || have[1] === want[1]);
}

export function pickVersion(versions: string[], req: string): string | null {
  const ok = versions.filter(v => /^\d+\.\d+\.\d+$/.test(v) && satisfies(v, req)).sort(cmpVersion);
  return ok.length ? ok[ok.length - 1] : null;
}

interface Index {
  packages: Record<string, { git: string; versions: string[] }>;
}

let indexCache: Index | null = null;

function fetchIndex(): Index {
  if (indexCache) return indexCache;
  const where = process.env.LUMEN_REGISTRY ?? DEFAULT_REGISTRY;
  const url = /^[a-z]+:\/\//.test(where) ? where : pathToFileURL(resolve(where)).href;
  indexCache = JSON.parse(httpGet(url)) as Index;
  return indexCache;
}

function resolveFromIndex(name: string, req: string): { url: string; ref: string; version: string } {
  const entry = fetchIndex().packages[name];
  if (!entry) throw new Error(`package '${name}' is not in the index`);
  const version = pickVersion(entry.versions, req);
  if (!version) throw new Error(`no version of '${name}' matches ${req} (the index has ${entry.versions.join(', ')})`);
  return { url: entry.git, ref: `v${version}`, version };
}

// ---- lockfile

type Lock = Map<string, { spec: string; commit: string; source?: string }>;

function readLock(file: string): Lock {
  const lock: Lock = new Map();
  if (!existsSync(file)) return lock;
  let cur: { name?: string; spec?: string; commit?: string; source?: string } = {};
  const flush = () => {
    if (cur.name && cur.spec && cur.commit) lock.set(cur.name, { spec: cur.spec, commit: cur.commit, source: cur.source });
    cur = {};
  };
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '[[package]]') {
      flush();
      continue;
    }
    const m = /^(name|spec|commit|source)\s*=\s*"([^"]*)"$/.exec(line.trim());
    if (m) cur[m[1] as 'name' | 'spec' | 'commit' | 'source'] = m[2];
  }
  flush();
  return lock;
}

function writeLock(file: string, lock: Lock) {
  const names = [...lock.keys()].sort();
  const body = names.map(n => {
    const e = lock.get(n)!;
    return `[[package]]\nname = "${n}"\nspec = "${e.spec}"\n${e.source ? `source = "${e.source}"\n` : ''}commit = "${e.commit}"\n`;
  }).join('\n');
  if (names.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, '# written by lumen install, commit it so everyone gets the same code\n\n' + body);
}

const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });

// path deps need nothing; git deps are cloned into .lumen/deps/<name> at the commit the lockfile names
// (or at the ref in the manifest the first time), then their own dependencies are installed the same way.
// a version requirement is turned into a git url and tag through the package index
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
      let source = '';
      if (d.registry) {
        if (valid && locked.source) {
          source = locked.source;
        } else {
          try {
            const r = resolveFromIndex(d.name, d.spec);
            source = `${r.url}#${r.ref}`;
          } catch (e) {
            out.push(`${id}: failed, ${(e as Error).message}`);
            continue;
          }
        }
        const h = source.lastIndexOf('#');
        d.url = source.slice(0, h);
        d.ref = source.slice(h + 1);
      }
      // a version from the index is pinned by its tag, so a lock entry never has to override it
      const want = valid ? locked.commit : d.ref;
      if (!existsSync(d.dir)) {
        mkdirSync(dirname(d.dir), { recursive: true });
        const c = spawnSync('git', ['clone', '-q', '--', d.url, d.dir], { stdio: 'inherit' });
        if (c.status !== 0) {
          out.push(`${id}: clone failed`);
          continue;
        }
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
      else if (head) lock.set(id, { spec: d.spec, commit: head, source: source || undefined });
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
