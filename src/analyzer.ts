import type { Diagnostic, Segment, Severity, Span } from './diagnostics.ts';
import type { EnumDecl, Expr, FieldInit, FnDecl, FnSym, Pat, Program, Stmt, StructDecl, TraitDecl, VarSym } from './ast.ts';
import { BUILTINS, arrayOf, elemOf, fnSig, fnType, hasFn, isArray, isBuiltin, isFn, isNumeric, isEnum, isRef, isStruct, structName } from './types.ts';
import type { Elem, FnType, Type } from './types.ts';

class Scope {
  vars = new Map<string, VarSym>();
  parent: Scope | null;
  constructor(parent: Scope | null) {
    this.parent = parent;
  }
  lookup(name: string): VarSym | null {
    for (let s: Scope | null = this; s; s = s.parent) {
      const v = s.vars.get(name);
      if (v) return v;
    }
    return null;
  }
}

// every identifier a body mentions, and every name it declares itself (lets, loop vars, match bindings, nested lambda params)
function namesIn(body: Stmt[], used: Set<string>, declared: Set<string>) {
  const pat = (p: Pat) => {
    if (p.k === 'variant') p.binds?.forEach(b => b && declared.add(b.name));
  };
  const ex = (e: Expr): void => {
    switch (e.k) {
      case 'var': used.add(e.name); return;
      case 'unary': ex(e.arg); return;
      case 'binary': ex(e.l); ex(e.r); return;
      case 'call': used.add(e.name); e.args.forEach(ex); if (e.callee) ex(e.callee); return;
      case 'array': e.elems.forEach(ex); return;
      case 'index': ex(e.arr); ex(e.idx); return;
      case 'field': ex(e.obj); return;
      case 'mcall': ex(e.obj); e.args.forEach(ex); return;
      case 'enumctor': e.args.forEach(ex); return;
      case 'structlit': e.fields.forEach(f => ex(f.value)); return;
      case 'matchx': ex(e.scrut); e.arms.forEach(a => { a.pats.forEach(pat); ex(a.value); }); return;
      case 'lambda': e.fn.params.forEach(p => declared.add(p.name)); namesIn(e.fn.body, used, declared); return;
    }
  };
  const st = (s: Stmt): void => {
    switch (s.k) {
      case 'let': declared.add(s.name); ex(s.init); return;
      case 'assign': used.add(s.name); ex(s.value); return;
      case 'expr': ex(s.e); return;
      case 'if': ex(s.cond); s.then.forEach(st); s.els?.forEach(st); return;
      case 'while': ex(s.cond); s.body.forEach(st); return;
      case 'return': if (s.value) ex(s.value); return;
      case 'block': s.body.forEach(st); return;
      case 'setindex': ex(s.arr); ex(s.idx); ex(s.value); return;
      case 'setfield': ex(s.obj); ex(s.value); return;
      case 'match': ex(s.scrut); s.arms.forEach(a => { a.pats.forEach(pat); a.body.forEach(st); }); return;
    }
  };
  body.forEach(st);
}

// generic functions are templates: each distinct set of type arguments gets its own checked copy
function unify(pat: string, actual: Type, params: Set<string>, binds: Map<string, Type>, insts: Map<string, { tmpl: string; args: Type[] }>) {
  if (actual === 'error' || actual === 'void') return;
  if (pat.startsWith('@') && params.has(pat.slice(1))) {
    if (!binds.has(pat.slice(1))) binds.set(pat.slice(1), actual);
  } else if (pat.endsWith('[]') && isArray(actual)) {
    unify(pat.slice(0, -2), elemOf(actual), params, binds, insts);
  } else if (pat.startsWith('<') && pat.endsWith('>') && isFn(actual)) {
    const want = fnSig(pat as FnType);
    const got = fnSig(actual);
    want.params.forEach((p, i) => { if (got.params[i]) unify(p, got.params[i], params, binds, insts); });
    unify(want.ret, got.ret, params, binds, insts);
  } else if (isStruct(actual) || isEnum(actual)) {
    const m = /^[@#]([A-Za-z_][A-Za-z0-9_]*)<(.*)>$/s.exec(pat);
    const info = insts.get(actual.slice(1));
    if (m && info && info.tmpl === m[1]) splitTop(m[2]).forEach((p, i) => unify(p, info.args[i], params, binds, insts));
  }
}

const replaceVars = (v: string, map: Map<string, Type>) => v.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (m, n: string) => map.get(n) ?? m);

// applies fn to every written type inside an AST fragment; `skip` keeps templates out of the walk
function mapTypes(node: unknown, fn: (t: string, owner: Record<string, unknown>) => string, skip?: (o: Record<string, unknown>) => boolean) {
  if (Array.isArray(node)) {
    node.forEach(n => mapTypes(n, fn, skip));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (skip?.(o)) return;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if ((k === 'ty' || k === 'annot' || k === 'ret') && typeof v === 'string') o[k] = fn(v, o);
    else if ((k === 'tys' || k === 'payload') && Array.isArray(v)) o[k] = v.map(x => fn(x as string, o));
    else mapTypes(v, fn, skip);
  }
}

// splits "A,B<C,D>,E" at the commas that are not nested
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(' || s[i] === '<') depth++;
    else if (s[i] === ')' || s[i] === '>') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  if (from < s.length) out.push(s.slice(from));
  return out;
}

function lambdasIn(node: unknown, out: Extract<Expr, { k: 'lambda' }>[]) {
  if (Array.isArray(node)) {
    node.forEach(n => lambdasIn(n, out));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (o.k === 'lambda') out.push(o as unknown as Extract<Expr, { k: 'lambda' }>);
  for (const k of Object.keys(o)) {
    // symbols and resolved callees point back into the tree, only a lambda's own fn is part of it
    if (k === 'sym' || k === 'decl' || (k === 'fn' && o.k !== 'lambda')) continue;
    lambdasIn(o[k], out);
  }
}

// names a closure in this body mentions without declaring them itself: if one is a local `var` it has to be shared
function boxNamesOf(body: Stmt[]): Set<string> {
  const out = new Set<string>();
  const ls: Extract<Expr, { k: 'lambda' }>[] = [];
  lambdasIn(body, ls);
  for (const l of ls) {
    const used = new Set<string>();
    const declared = new Set<string>(l.fn.params.map(p => p.name));
    namesIn(l.fn.body, used, declared);
    for (const n of used) if (!declared.has(n)) out.add(n);
  }
  return out;
}

// builtins that do something besides returning a value
const EFFECTS = new Set(['print', 'push', 'pop', 'sort', 'reverse', 'assert', 'exit', 'read_line']);

// internal type spellings (@Name, <fn(int):int>) back to what the user wrote
function showTypes(msg: string): string {
  let out = msg.replaceAll('@', '').replaceAll('$', '.');
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/<fn\(([^<>]*)\):([^<>]*)>(\[\])?/g, (_, ps: string, r: string, arr?: string) => {
      const text = `fn(${ps.replace(/,(?! )/g, ', ')})` + (r === 'void' ? '' : `: ${r}`);
      return arr ? `(${text})[]` : text;
    });
  }
  return out;
}

interface FnCtx {
  boxNames: Set<string>; // vars some closure in this function captures
  ret: Type;
  nlocals: number;
  isMain: boolean;
  name: string;
}

interface Flow {
  diverges: boolean; // control never reaches the next statement
  returns: boolean; // never falls off the end of the function
}

const NEXT: Flow = { diverges: false, returns: false };

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function closestHint(name: string, cands: string[]): string | undefined {
  const c = closest(name, cands);
  return c ? `did you mean '${c}'?` : `available: ${cands.join(', ')}`;
}

function closest(name: string, cands: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bd = Math.max(1, Math.floor(name.length / 3)) + 1;
  for (const c of cands) {
    const d = editDistance(name, c);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

class Analyzer {
  diags: Diagnostic[] = [];
  fns = new Map<string, FnSym>();
  structs = new Map<string, StructDecl>();
  enums = new Map<string, EnumDecl>();
  globals = new Scope(null);
  scope = this.globals;
  ctx: FnCtx = { boxNames: new Set(), ret: 'void', nlocals: 0, isMain: true, name: '<main>' };
  nglobals = 0;
  loops: { sawBreak: boolean }[] = [];
  allVars: VarSym[] = [];
  ninst = 0;
  segments: Segment[] = [];
  traits = new Map<string, TraitDecl>();
  dynByEnum = new Map<string, { enumName: string; variants: { variant: string; type: Type; implType: string }[] }>();
  dynTraits = new Map<string, { enumName: string; variants: { variant: string; type: Type; implType: string }[] }>();
  impls = new Set<string>(); // "Trait for <type string>"
  enumTemplates = new Map<string, EnumDecl>();
  keep = new Map<Expr, Type>(); // arguments already typed while inferring a generic's type arguments
  structTemplates = new Map<string, StructDecl>();
  structKeys = new Map<string, string>(); // Box<int> -> Box__int
  structInst = new Map<string, { tmpl: string; args: Type[] }>();
  generics = new Map<string, FnDecl>();
  calledGenerics = new Set<string>();
  insts = new Map<string, FnSym>();
  prog!: Program;

  report(severity: Severity, code: string, message: string, span: Span, hint?: string) {
    // generic instances re-check the same source, report each problem once
    let msg = showTypes(message);
    for (const [inst, info] of this.structInst) msg = msg.replaceAll(inst, `${info.tmpl}<${info.args.map(a => showTypes(a)).join(', ')}>`);
    if (this.diags.some(d => d.code === code && d.span.start === span.start && d.span.end === span.end && d.message === msg)) return;
    this.diags.push({ severity, code, message: msg, span, hint });
  }
  err(code: string, message: string, span: Span, hint?: string) { this.report('error', code, message, span, hint); }
  warn(code: string, message: string, span: Span, hint?: string) { this.report('warning', code, message, span, hint); }

  run(prog: Program) {
    this.prog = prog;

    for (const sd of prog.structs) if (sd.typeParams) this.structTemplates.set(sd.name, sd);
    prog.structs = prog.structs.filter(sd => !sd.typeParams);
    for (const ed of prog.enums) if (ed.typeParams) this.enumTemplates.set(ed.name, ed);
    prog.enums = prog.enums.filter(ed => !ed.typeParams);
    const templateFns = new Set<unknown>();
    for (const f of prog.fns) {
      if (!f.typeParams) continue;
      templateFns.add(f);
      const ls: Extract<Expr, { k: 'lambda' }>[] = [];
      lambdasIn(f.body, ls);
      ls.forEach(l => templateFns.add(l.fn));
    }
    {
      // written Name<Args> types become real (monomorphized) structs before anything else looks at types
      const canon = (t: string, o: Record<string, unknown>) => this.canon(t, (o.span as Span | undefined) ?? { start: 0, end: 0 });
      const skip = (o: Record<string, unknown>) => templateFns.has(o);
      mapTypes(prog.enums, canon, skip);
      mapTypes(prog.structs, canon, skip);
      mapTypes(prog.fns, canon, skip);
      mapTypes(prog.body, canon, skip);
    }
    // `impl Trait for Box<int>` / `impl Box<int> { ... }`: the owner in the names is the instance now
    const ownerName = (written: string) => this.canon((this.enumTemplates.has(written.split('<')[0]) ? '#' : '@') + written, prog.body[0]?.span ?? { start: 0, end: 0 }).slice(1);
    for (const f of prog.fns) {
      const dollar = f.name.indexOf('$');
      if (dollar > 0 && f.name.slice(0, dollar).includes('<')) f.name = ownerName(f.name.slice(0, dollar)) + f.name.slice(dollar);
    }
    for (const im of prog.impls) if (im.type.includes('<')) im.type = ownerName(im.type);
    this.synthDyn(prog);
    this.declareEnums(prog.enums);
    this.declareStructs(prog.structs);
    for (const d of this.enums.values()) {
      for (const v of d.variants) v.payload.forEach(t => this.checkType(t, v.span));
    }
    // lambdas inside a generic body belong to the template, every instance gets its own copy
    const templateLambdas = new Set<FnDecl>();
    for (const f of prog.fns) {
      if (!f.typeParams) continue;
      this.generics.set(f.name, f);
      const ls: Extract<Expr, { k: 'lambda' }>[] = [];
      lambdasIn(f.body, ls);
      ls.forEach(l => templateLambdas.add(l.fn));
    }
    for (const t of prog.traits) {
      for (const m of t.methods) {
        const ls: Extract<Expr, { k: 'lambda' }>[] = [];
        lambdasIn(m.body ?? [], ls);
        ls.forEach(l => templateLambdas.add(l.fn));
      }
    }
    for (const f of prog.fns) {
      if (!f.typeParams && !templateLambdas.has(f)) this.declareFn(f);
    }

    this.checkTraits(prog);
    this.checkQualified(prog);

    this.ctx.boxNames = boxNamesOf(prog.body);
    this.analyzeBlockBody(prog.body);

    for (const v of this.allVars) this.lintVar(v);
    for (const f of this.fns.values()) {
      if (!f.used) this.warn('W005', `function '${f.name}' is never called`, f.decl.nameSpan);
    }

    for (const g of this.generics.values()) {
      if (!this.calledGenerics.has(g.name) && !g.name.startsWith('_')) {
        this.warn('W011', `generic function '${g.name}' is never called, so its body was not checked`, g.nameSpan);
      }
    }
    prog.fns = prog.fns.filter(f => f.sym);
    prog.nlocals = this.ctx.nlocals;
    prog.nglobals = this.nglobals;
    this.diags.sort((a, b) => a.span.start - b.span.start);
  }

  isBoxed(t: Type): boolean {
    const d = isEnum(t) ? this.enums.get(t.slice(1)) : undefined;
    return !!d && d.variants.some(v => v.payload.length > 0);
  }

  declareEnums(list: EnumDecl[]) {
    for (const d of list) {
      if (this.enums.get(d.name) === d) continue; // instance registered while canonicalising types
      if (this.enums.has(d.name)) {
        this.err('E006', `enum '${d.name}' is already defined`, d.nameSpan);
        continue;
      }
      this.enums.set(d.name, d);
      const seen = new Set<string>();
      for (const v of d.variants) {
        if (seen.has(v.name)) this.err('E006', `variant '${v.name}' is declared twice in enum '${d.name}'`, v.span);
        seen.add(v.name);
      }
    }
  }

  // rewrites every `@Name<A,B>` in a type string to the instance's own name, creating the instance on first use
  canon(t: string, span: Span): string {
    let out = '';
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== '@' && t[i] !== '#') {
        out += t[i];
        continue;
      }
      const prefix = t[i];
      let j = i + 1;
      while (j < t.length && /[A-Za-z0-9_]/.test(t[j])) j++;
      const name = t.slice(i + 1, j);
      if (t[j] !== '<') {
        out += t.slice(i, j);
        i = j - 1;
        continue;
      }
      let depth = 0;
      let k = j;
      for (; k < t.length; k++) {
        if (t[k] === '<') depth++;
        else if (t[k] === '>' && --depth === 0) break;
      }
      const args = splitTop(t.slice(j + 1, k)).map(a => this.canon(a, span) as Type);
      const inst = prefix === '@' ? this.structInstance(name, args, span) : this.enumInstance(name, args, span);
      out += inst ? prefix + inst : 'error';
      i = k;
    }
    return out;
  }

  structInstance(name: string, args: Type[], span: Span): string | null {
    const tmpl = this.structTemplates.get(name);
    if (!tmpl) {
      this.err('E016', this.structs.has(name) ? `struct '${name}' is not generic` : `unknown struct '${name}'`, span);
      return null;
    }
    if (args.length !== tmpl.typeParams!.length) {
      this.err('E016', `struct '${name}' takes ${tmpl.typeParams!.length} type argument${tmpl.typeParams!.length === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} given`, span);
      return null;
    }
    const key = `${name}<${args.join(',')}>`;
    const known = this.structKeys.get(key);
    if (known) return known;

    let inst = `${name}__${args.map(a => a.replace(/[^A-Za-z0-9_]/g, '_')).join('__')}`;
    while (this.structs.has(inst) || this.enums.has(inst) || [...this.structKeys.values()].includes(inst)) inst += '_';
    this.structKeys.set(key, inst);
    this.structInst.set(inst, { tmpl: name, args });
    const map = new Map<string, Type>(tmpl.typeParams!.map((p, i) => [p, args[i]]));
    const decl: StructDecl = {
      k: 'struct', span: tmpl.span, name: inst, nameSpan: tmpl.nameSpan, shown: name.split('$').pop(), pub: tmpl.pub,
      fields: tmpl.fields.map(f => ({ name: f.name, span: f.span, ty: this.canon(replaceVars(f.ty, map), f.span) as Type })),
    };
    this.structs.set(inst, decl);
    this.prog.structs.push(decl);
    // fields of an instance created after declareStructs ran still have to name real types
    for (const f of decl.fields) this.checkType(f.ty, f.span);
    return inst;
  }

  enumInstance(name: string, args: Type[], span: Span): string | null {
    const tmpl = this.enumTemplates.get(name);
    if (!tmpl) {
      this.err('E016', this.enums.has(name) ? `enum '${name}' is not generic` : `unknown enum '${name}'`, span);
      return null;
    }
    if (args.length !== tmpl.typeParams!.length) {
      this.err('E016', `enum '${name}' takes ${tmpl.typeParams!.length} type argument${tmpl.typeParams!.length === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} given`, span);
      return null;
    }
    const key = `#${name}<${args.join(',')}>`;
    const known = this.structKeys.get(key);
    if (known) return known;

    let inst = `${name}__${args.map(a => a.replace(/[^A-Za-z0-9_]/g, '_')).join('__')}`;
    while (this.structs.has(inst) || this.enums.has(inst) || [...this.structKeys.values()].includes(inst)) inst += '_';
    this.structKeys.set(key, inst);
    this.structInst.set(inst, { tmpl: name, args });
    const map = new Map<string, Type>(tmpl.typeParams!.map((p, i) => [p, args[i]]));
    const decl: EnumDecl = {
      k: 'enum', span: tmpl.span, name: inst, nameSpan: tmpl.nameSpan, pub: tmpl.pub,
      variants: tmpl.variants.map(v => ({ name: v.name, span: v.span, payload: v.payload.map(p => this.canon(replaceVars(p, map), v.span) as Type) })),
    };
    this.enums.set(inst, decl);
    this.prog.enums.push(decl);
    for (const v of decl.variants) v.payload.forEach(t => this.checkType(t, v.span));
    return inst;
  }

  // which instance of a generic enum an expression like Option.Some(1) or Option.None builds
  enumFor(tmpl: EnumDecl, want: Type | undefined, variant: string, args: Expr[], span: Span): string | null {
    if (want === 'error') {
      args.forEach(a => this.expr(a));
      return null;
    }
    const info = want && isEnum(want) ? this.structInst.get(want.slice(1)) : undefined;
    const binds = new Map<string, Type>();
    if (info && info.tmpl === tmpl.name) {
      tmpl.typeParams!.forEach((p, i) => binds.set(p, info.args[i]));
    } else {
      const v = tmpl.variants.find(x => x.name === variant);
      if (!v) {
        args.forEach(a => this.expr(a));
        this.err('E021', `enum '${tmpl.name}' has no variant '${variant}'`, span, closestHint(variant, tmpl.variants.map(x => x.name)));
        return null;
      }
      const params = new Set(tmpl.typeParams!);
      args.forEach((a, i) => {
        const t = this.expr(a);
        this.keep.set(a, t);
        if (i < v.payload.length) unify(v.payload[i], t, params, binds, this.structInst);
      });
    }
    const missing = tmpl.typeParams!.find(p => !binds.has(p));
    if (missing) {
      if (args.some(a => this.keep.get(a) === 'error')) return null;
      this.err('E024', `cannot infer type parameter '${missing}' of enum '${tmpl.name}'`, span, `add a type annotation, e.g. let x: ${tmpl.name}<int> = ...`);
      return null;
    }
    return this.enumInstance(tmpl.name, tmpl.typeParams!.map(p => binds.get(p)!), span);
  }

  declareStructs(list: StructDecl[]) {
    for (const s of list) {
      if (this.structs.get(s.name) === s) continue; // instance registered while canonicalising types
      if (this.enums.has(s.name)) this.err('E006', `'${s.name}' is already defined as an enum`, s.nameSpan);
      else if (this.structs.has(s.name)) this.err('E006', `struct '${s.name}' is already defined`, s.nameSpan);
      else this.structs.set(s.name, s);
    }
    for (const s of this.structs.values()) {
      const seen = new Set<string>();
      for (const f of s.fields) {
        if (seen.has(f.name)) this.err('E006', `field '${f.name}' is declared twice in struct '${s.name}'`, f.span);
        seen.add(f.name);
        this.checkType(f.ty, f.span);
      }
    }
    // a struct that contains itself by value could never be constructed
    for (const s of this.structs.values()) {
      const path = new Set<string>();
      const walk = (d: StructDecl): boolean => {
        if (path.has(d.name)) return d.name === s.name;
        path.add(d.name);
        for (const f of d.fields) {
          if (!isStruct(f.ty)) continue;
          const next = this.structs.get(structName(f.ty));
          if (next && walk(next)) return true;
        }
        path.delete(d.name);
        return false;
      };
      if (walk(s)) this.err('E017', `struct '${s.name}' contains itself`, s.nameSpan, 'use an array field (e.g. children: Node[]) to break the cycle');
    }
  }

  // with imports, a top-level fn/struct/enum is only usable from other files when it is `pub`
  fileOf(span: Span): string | undefined {
    return this.segments.find(s => span.start >= s.start && span.start <= s.end)?.name;
  }

  access(kind: string, name: string, decl: { pub?: boolean; nameSpan: Span } | undefined, use: Span) {
    if (!decl || decl.pub || !this.segments.length) return;
    const home = this.fileOf(decl.nameSpan);
    if (home && home !== this.fileOf(use)) {
      this.err('E027', `${kind} '${name}' is private to ${home}`, use, `declare it with 'pub ${kind === 'function' ? 'fn' : kind}' to use it from other files`);
    }
  }

  // struct names are only known after parsing, so every written type goes through here
  checkType(t: Type, span: Span) {
    let base: Type = t;
    while (isArray(base)) base = elemOf(base);
    if (isFn(base)) {
      const sig = fnSig(base);
      for (const p of sig.params) this.checkType(p, span);
      this.checkType(sig.ret, span);
    } else if (isEnum(base) && this.enums.has(base.slice(1))) {
      this.access('enum', base.slice(1), this.enums.get(base.slice(1)), span);
    } else if (isStruct(base) && this.structs.has(structName(base))) {
      this.access('struct', structName(base), this.structs.get(structName(base)), span);
    } else if (isEnum(base)) {
      this.err('E016', `unknown type '${base.slice(1)}'`, span);
    } else if (isStruct(base)) {
      const sug = closest(structName(base), this.structs.keys());
      this.err('E016', `unknown type '${structName(base)}'`, span, sug ? `did you mean '${sug}'?` : 'valid types: int, float, bool, string, or a declared struct');
    }
  }

  declareFn(f: FnDecl) {
    for (const p of f.params) this.checkType(p.ty, p.span);
    this.checkType(f.ret, f.nameSpan);
    if (isBuiltin(f.name)) {
      this.err('E006', `'${f.name}' is a built-in function and cannot be redefined`, f.nameSpan);
      return;
    }
    const prev = this.fns.get(f.name);
    if (prev) {
      this.err('E006', `function '${f.name}' is already defined`, f.nameSpan);
      return;
    }
    f.sym = {
      name: f.name,
      params: f.params.map(p => p.ty),
      ret: f.ret,
      index: this.fns.size,
      span: f.nameSpan,
      used: false,
      decl: f,
    };
    this.fns.set(f.name, f.sym);
  }

  declareVar(name: string, ty: Type, mutable: boolean, span: Span, isParam = false): VarSym {
    const where = this.scope === this.globals ? 'global' : 'local';
    const sym: VarSym = {
      name, ty, mutable, where, span, isParam,
      slot: where === 'global' ? this.nglobals++ : this.ctx.nlocals++,
      used: false, assigned: false,
    };
    const dup = this.scope.vars.get(name);
    if (dup) {
      this.err('E006', `'${name}' is already declared in this scope`, span, 'use a different name, or drop the second declaration');
    } else {
      const outer = this.scope.parent?.lookup(name);
      if (outer && !name.startsWith('_') && !(isParam && outer.where === 'global')) {
        this.warn('W003', `'${name}' shadows an outer variable`, span);
      }
      this.scope.vars.set(name, sym);
    }
    this.allVars.push(sym);
    return sym;
  }

  lintVar(v: VarSym) {
    if (v.name.startsWith('_') || (v.isParam && v.name === 'self')) return;
    if (!v.used) {
      this.warn(v.isParam ? 'W002' : 'W001', `unused ${v.isParam ? 'parameter' : 'variable'} '${v.name}'`, v.span, `prefix with '_' to silence`);
    }
    if (v.mutable && !v.assigned && !v.isParam) {
      this.warn('W007', `'${v.name}' is declared with 'var' but never reassigned`, v.span, `use 'let' instead`);
    }
  }

  withScope<T>(fn: () => T): T {
    const saved = this.scope;
    this.scope = new Scope(saved);
    try {
      return fn();
    } finally {
      this.scope = saved;
    }
  }

  analyzeFn(f: FnDecl) {
    if (!f.sym) return; // duplicate declaration, already reported
    const savedCtx = this.ctx;
    const savedLoops = this.loops;
    this.ctx = { boxNames: boxNamesOf(f.body), ret: f.ret, nlocals: 0, isMain: false, name: f.name };
    this.loops = [];

    this.withScope(() => {
      for (const p of f.params) {
        p.sym = this.declareVar(p.name, p.ty, p.mutable ?? false, p.span, true);
        if (p.box) p.sym.box = p.box;
        p.sym.origin = p.from;
      }
      const flow = this.withScope(() => this.block(f.body));
      if (f.ret !== 'void' && !flow.returns) {
        this.err('E007', `function '${f.name}' does not return a value on every path`, f.nameSpan, `add a 'return' at the end or in the missing branch`);
      }
    });

    f.nlocals = this.ctx.nlocals;
    this.ctx = savedCtx;
    this.loops = savedLoops;
  }

  // top level uses the global scope directly (no extra scope)
  analyzeBlockBody(body: Stmt[]) {
    this.block(body);
  }

  block(body: Stmt[]): Flow {
    let diverges = false;
    let returns = false;
    let warned = false;
    for (const s of body) {
      if (diverges && !warned && s.k !== 'fn') {
        this.warn('W004', 'unreachable code', s.span);
        warned = true;
      }
      const f = this.stmt(s);
      if (f.diverges) diverges = true;
      if (f.returns) returns = true;
    }
    return { diverges, returns };
  }

  stmt(s: Stmt): Flow {
    switch (s.k) {
      case 'fn':
        this.analyzeFn(s);
        return NEXT;

      case 'struct':
      case 'enum':
        return NEXT;

      case 'match': return this.matchStmt(s);

      case 'setfield': {
        const ot = this.expr(s.obj);
        const fld = this.fieldOf(ot, s.name, s.nameSpan, s.obj.span);
        if (fld) s.idx = fld.idx;
        const vt = this.expr(s.value, fld?.ty);
        if (fld && vt !== 'error' && vt !== fld.ty) this.mismatch(fld.ty, vt, s.value.span, `in assignment to field '${s.name}'`);
        return NEXT;
      }

      case 'let': {
        if (s.annot) this.checkType(s.annot, s.annotSpan ?? s.nameSpan);
        const t = this.expr(s.init, s.annot);
        let ty: Type = s.annot ?? t;
        if (t === 'void') {
          this.err('E010', 'a function that returns nothing cannot be used as a value', s.init.span);
          ty = 'error';
        } else if (/^_\$[ei]/.test(s.name) && t !== 'int' && t !== 'error') {
          // hidden bindings made by the parser for `for a..b`
          this.err('E003', `range bounds must be int, found ${t}`, s.init.span);
          ty = 'error';
        } else if (s.name.startsWith('_$a') && !isArray(t) && t !== 'error') {
          this.err('E003', `cannot iterate over a value of type ${t}`, s.init.span, 'for loops work on int ranges (a..b) and arrays');
          ty = 'error';
        } else if (s.annot && s.annot !== 'error' && t !== 'error' && t !== s.annot) {
          this.mismatch(s.annot, t, s.init.span);
        }
        // declared after the initializer so `let x = x + 1` sees the outer x
        if (s.mutable && ty !== 'error' && this.scope !== this.globals && this.ctx.boxNames.has(s.name)) {
          // a closure captures this var: keep it in a one-element array so every holder sees the same cell
          s.init = { k: 'array', elems: [s.init], span: s.init.span, ty: arrayOf(ty as Elem) };
          s.sym = this.declareVar(s.name, arrayOf(ty as Elem), true, s.nameSpan);
          s.sym.box = ty;
          return NEXT;
        }
        s.sym = this.declareVar(s.name, ty, s.mutable, s.nameSpan);
        return NEXT;
      }

      case 'assign': {
        const sym = this.scope.lookup(s.name);
        const vty = sym ? (sym.box ?? sym.ty) : undefined;
        const t = this.expr(s.value, vty);
        if (!sym) {
          this.undefinedVar(s.name, s.nameSpan);
          return NEXT;
        }
        s.sym = sym;
        if (!sym.mutable) {
          this.err('E005', `cannot assign to '${s.name}' because it is not declared with 'var'`, s.nameSpan,
            sym.isParam ? 'parameters are immutable; copy it into a local var first' : `declare it with 'var ${s.name} = ...'`);
        }
        for (let o: VarSym | undefined = sym; o; o = o.origin) o.assigned = true;
        if (t === 'void') this.err('E010', 'a function that returns nothing cannot be used as a value', s.value.span);
        else if (t !== 'error' && vty !== 'error' && t !== vty) this.mismatch(vty!, t, s.value.span);
        if (s.value.k === 'var' && s.value.name === s.name) this.warn('W009', `'${s.name}' is assigned to itself`, s.span);
        if (sym.box) {
          const cell: Expr = { k: 'var', name: s.name, span: s.nameSpan, ty: sym.ty, sym, raw: true };
          const zero: Expr = { k: 'int', value: 0, span: s.nameSpan, ty: 'int' };
          Object.assign(s, { k: 'setindex', arr: cell, idx: zero });
        }
        return NEXT;
      }

      case 'setindex': {
        const at = this.expr(s.arr);
        const it = this.expr(s.idx);
        const elem = isArray(at) ? elemOf(at) : undefined;
        const vt = this.expr(s.value, elem);
        if (at !== 'error' && !elem) this.err('E003', `cannot index a value of type ${at}`, s.arr.span);
        if (it !== 'error' && it !== 'int') this.err('E003', `array index must be int, found ${it}`, s.idx.span);
        this.negativeIndex(s.idx);
        if (elem && vt !== 'error' && vt !== elem) this.mismatch(elem, vt, s.value.span, 'in array element assignment');
        return NEXT;
      }

      case 'expr': {
        this.expr(s.e);
        if (s.e.k !== 'call') this.warn('W008', 'expression result is unused', s.e.span);
        else if (s.e.builtin && !EFFECTS.has(s.e.builtin)) this.warn('W008', `result of '${s.e.builtin}' is unused`, s.e.span);
        return NEXT;
      }

      case 'if': {
        this.cond(s.cond, 'if');
        const a = this.withScope(() => this.block(s.then));
        const b = s.els ? this.withScope(() => this.block(s.els!)) : NEXT;
        return { diverges: a.diverges && b.diverges, returns: a.returns && b.returns };
      }

      case 'while': {
        this.cond(s.cond, 'while');
        const loop = { sawBreak: false };
        this.loops.push(loop);
        this.withScope(() => this.block(s.body));
        this.loops.pop();
        const forever = s.cond.k === 'bool' && s.cond.value && !loop.sawBreak;
        return { diverges: forever, returns: forever };
      }

      case 'return': {
        if (this.ctx.isMain) {
          this.err('E009', "'return' outside of a function", s.span);
          return { diverges: true, returns: true };
        }
        const want = this.ctx.ret;
        if (s.value) {
          const t = this.expr(s.value, want);
          if (want === 'void') this.err('E003', `function '${this.ctx.name}' returns nothing, but a value is returned`, s.value.span);
          else if (t === 'void') this.err('E010', 'a function that returns nothing cannot be used as a value', s.value.span);
          else if (t !== 'error' && t !== want) this.mismatch(want, t, s.value.span, `in the return value of '${this.ctx.name}'`);
        } else if (want !== 'void') {
          this.err('E003', `function '${this.ctx.name}' must return a value of type ${want}`, s.span);
        }
        return { diverges: true, returns: true };
      }

      case 'break':
      case 'continue': {
        const loop = this.loops[this.loops.length - 1];
        if (!loop) this.err('E008', `'${s.k}' outside of a loop`, s.span);
        else if (s.k === 'break') loop.sawBreak = true;
        return { diverges: true, returns: false };
      }

      case 'block': {
        return this.withScope(() => this.block(s.body));
      }
    }
  }

  // Color.Red parses as a field access; once we know Color is an enum, turn the node into a constant
  enumValue(e: Extract<Expr, { k: 'field' }>, want?: Type): Type {
    const tm = this.enumTemplates.get((e.obj as Extract<Expr, { k: 'var' }>).name);
    if (tm) {
      const inst = this.enumFor(tm, want, e.name, [], e.nameSpan);
      if (!inst) return 'error';
      (e.obj as Extract<Expr, { k: 'var' }>).name = inst;
    }
    const decl = this.enums.get((e.obj as Extract<Expr, { k: 'var' }>).name)!;
    const idx = decl.variants.findIndex(v => v.name === e.name);
    if (idx < 0) {
      this.err('E021', `enum '${decl.name}' has no variant '${e.name}'`, e.nameSpan, closestHint(e.name, decl.variants.map(v => v.name)));
      return 'error';
    }
    const need = decl.variants[idx].payload.length;
    if (need > 0) {
      this.err('E022', `variant '${e.name}' carries ${need} value${need === 1 ? '' : 's'}, write ${decl.name}.${e.name}(...)`, e.span);
      return 'error';
    }
    Object.assign(e, { k: 'enumval', enumName: decl.name, variant: e.name, idx, boxed: this.isBoxed(('#' + decl.name) as Type) });
    return ('#' + decl.name) as Type;
  }

  // Shape.Circle(1.0): a call on `.name` is a constructor when the left side is an enum
  methodCall(e: Extract<Expr, { k: 'mcall' }>, hint?: Type): Type {
    // Shape.from(x) wraps a value of an implementing type into `dyn Shape`
    const dynName = e.obj.k === 'var' && !this.scope.lookup(e.obj.name) && e.name === 'from' && e.args.length === 1 ? e.obj.name : null;
    const dt = dynName ? this.dynTraits.get(dynName) : undefined;
    if (dt) {
      const at = this.expr(e.args[0]);
      this.keep.set(e.args[0], at);
      if (at === 'error') return 'error';
      const variant = dt.variants.find(x => x.type === at);
      if (!variant) {
        this.err('E025', `type ${at} does not implement trait '${dynName}'`, e.args[0].span, `add: impl ${dynName} for ${at.replace(/^[@#]/, '')} { ... }`);
        return 'error';
      }
      (e.obj as Extract<Expr, { k: 'var' }>).name = dt.enumName;
      e.name = variant.variant;
    }
    let tm = e.obj.k === 'var' && !this.scope.lookup(e.obj.name) ? this.enumTemplates.get(e.obj.name) : undefined;
    if (tm && this.generics.has(`${tm.name}$${e.name}`)) tm = undefined; // Option.map(...) is an associated function, not a variant
    if (tm) {
      const inst = this.enumFor(tm, hint, e.name, e.args, e.nameSpan);
      if (!inst) return 'error';
      (e.obj as Extract<Expr, { k: 'var' }>).name = inst;
    }
    const typeName = e.obj.k === 'var' && !this.scope.lookup(e.obj.name) && (this.enums.has(e.obj.name) || this.structs.has(e.obj.name) || this.structTemplates.has(e.obj.name) || this.enumTemplates.has(e.obj.name)) ? e.obj.name : null;
    const decl = typeName ? this.enums.get(typeName) : undefined;
    const idx = decl ? decl.variants.findIndex(v => v.name === e.name) : -1;

    if (typeName && idx < 0) {
      // Type.func(args): an associated function, enums report a bad variant when there is none either
      const fname = `${typeName}$${e.name}`;
      if (decl && !this.fns.has(fname)) {
        e.args.forEach(a => this.expr(a));
        this.err('E021', `enum '${decl.name}' has no variant or function '${e.name}'`, e.nameSpan, closestHint(e.name, decl.variants.map(v => v.name)));
        return 'error';
      }
      Object.assign(e, { k: 'call', name: fname, nameSpan: e.nameSpan });
      return this.call(e as unknown as Extract<Expr, { k: 'call' }>);
    }

    if (!decl) {
      // value.method(args)
      const ot = this.expr(e.obj);
      const rest = e.args.map(a => a);
      if (ot === 'error') {
        rest.forEach(a => this.expr(a));
        return 'error';
      }
      // a method of `impl<T> Box<T>`: the template is a generic function taking self first
      const instInfo = isStruct(ot) || isEnum(ot) ? this.structInst.get(ot.slice(1)) : undefined;
      const generic = instInfo ? this.generics.get(`${instInfo.tmpl}$${e.name}`) : undefined;
      if (generic && generic.params[0]?.name === 'self') {
        this.keep.set(e.obj, ot);
        Object.assign(e, { k: 'call', name: generic.name, args: [e.obj, ...e.args] });
        return this.genericCall(e as unknown as Extract<Expr, { k: 'call' }>, generic);
      }
      const owner = isStruct(ot) ? structName(ot) : isEnum(ot) ? ot.slice(1) : null;
      const fn = owner ? this.fns.get(`${owner}$${e.name}`) : undefined;
      const fld = isStruct(ot) ? this.structs.get(owner!)?.fields.find(f => f.name === e.name && isFn(f.ty)) : undefined;
      if (!fn && fld) {
        const field: Expr = { k: 'field', obj: e.obj, name: e.name, nameSpan: e.nameSpan, idx: -1, span: e.nameSpan, ty: 'error' };
        Object.assign(e, { k: 'call', callee: field });
        return this.call(e as unknown as Extract<Expr, { k: 'call' }>);
      }
      if (!fn || fn.params[0] !== ot || fn.decl.params[0].name !== 'self') {
        rest.forEach(a => this.expr(a));
        const cands = owner ? [...this.fns.values()].filter(f => f.name.startsWith(owner + '$') && f.decl.params[0]?.name === 'self').map(f => f.name.slice(owner.length + 1)) : [];
        this.err('E019', owner ? `type '${owner}' has no method '${e.name}'` : `cannot call a method on a value of type ${ot}`, e.nameSpan,
          cands.length ? closestHint(e.name, cands) : undefined);
        return 'error';
      }
      const argTys = [ot, ...rest.map((a, i) => this.expr(a, fn.params[i + 1]))];
      const call = e as unknown as Extract<Expr, { k: 'call' }>;
      Object.assign(e, { k: 'call', name: fn.name, args: [e.obj, ...e.args] });
      return this.checkUserCall(call, fn, argTys);
    }
    if (idx < 0) return 'error';
    const want = decl.variants[idx].payload;
    const tys = e.args.map((a, i) => this.expr(a, want[i]));
    if (e.args.length !== want.length) {
      this.err('E004', `variant '${decl.name}.${e.name}' takes ${want.length} value${want.length === 1 ? '' : 's'}, but ${e.args.length} ${e.args.length === 1 ? 'was' : 'were'} given`, e.span);
    } else {
      tys.forEach((t, i) => {
        if (t === 'void') this.err('E010', 'a function that returns nothing cannot be used as a value', e.args[i].span);
        else if (t !== 'error' && t !== want[i]) this.mismatch(want[i], t, e.args[i].span, `in argument ${i + 1} of '${decl.name}.${e.name}'`);
      });
    }
    Object.assign(e, { k: 'enumctor', enumName: decl.name, variant: e.name, idx });
    return ('#' + decl.name) as Type;
  }

  // names bound by a `Variant(a, b)` pattern live in the arm's scope
  declareBinds(pats: Pat[]) {
    for (const p of pats) {
      if (p.k !== 'variant' || !p.binds) continue;
      p.binds.forEach((b, j) => {
        if (b && p.tys[j]) b.sym = this.declareVar(b.name, p.tys[j], false, b.span);
      });
    }
  }

  matchStmt(s: Extract<Stmt, { k: 'match' }>): Flow {
    const r = this.matchCore(s.scrut, s.arms.map(a => a.pats), i => this.withScope(() => {
      this.declareBinds(s.arms[i].pats);
      return this.block(s.arms[i].body);
    }));
    s.tmp = r.tmp;
    const all = (k: 'diverges' | 'returns') => r.out.length > 0 && r.exhaustive && r.out.every(f => f[k]);
    return { diverges: all('diverges'), returns: all('returns') };
  }

  matchExpr(e: Extract<Expr, { k: 'matchx' }>, want?: Type): Type {
    const r = this.matchCore(e.scrut, e.arms.map(a => a.pats), i => this.withScope(() => {
      this.declareBinds(e.arms[i].pats);
      return this.expr(e.arms[i].value, want);
    }));
    e.tmp = r.tmp;
    let ty: Type = 'error';
    r.out.forEach((t, i) => {
      const at = e.arms[i].value.span;
      if (t === 'void') this.err('E010', 'a function that returns nothing cannot be used as a value', at);
      else if (t === 'error') return;
      else if (ty === 'error') ty = t;
      else if (t !== ty) this.mismatch(ty, t, at, 'in match arm');
    });
    return ty;
  }

  // shared by match statements and match expressions: pattern checks + exhaustiveness
  matchCore<T>(scrut: Expr, patLists: Pat[][], runArm: (i: number) => T): { tmp: number; out: T[]; exhaustive: boolean } {
    const st = this.expr(scrut);
    const tmp = this.ctx.nlocals++;
    const decl = isEnum(st) ? this.enums.get(st.slice(1)) : undefined;
    const matchable = st === 'bool' || st === 'int' || st === 'string' || !!decl;
    if (st !== 'error' && !matchable) this.err('E003', `cannot match on a value of type ${st}`, scrut.span, 'match works on enums, bool, int and string');

    const seen = new Set<string>();
    let wild = false;
    const out: T[] = [];
    for (let ai = 0; ai < patLists.length; ai++) {
      for (const p of patLists[ai]) {
        let key: string | null = null;
        if (p.k === 'wild') {
          if (wild) this.warn('W010', 'unreachable pattern', p.span);
          wild = true;
          continue;
        }
        if (p.k === 'variant') {
          const idx = decl ? decl.variants.findIndex(v => v.name === p.name) : -1;
          if (!decl) {
            if (matchable) this.err('E003', `'${p.name}' is not a valid pattern for ${st}`, p.span);
          } else if (idx < 0) {
            this.err('E021', `enum '${decl.name}' has no variant '${p.name}'`, p.span, closestHint(p.name, decl.variants.map(v => v.name)));
          } else {
            p.idx = idx;
            key = `v${idx}`;
            const v = decl.variants[idx];
            p.tys = v.payload;
            p.boxed = decl.variants.some(x => x.payload.length > 0);
            if (p.binds && p.binds.length !== v.payload.length) {
              this.err('E022', `variant '${v.name}' has ${v.payload.length} value${v.payload.length === 1 ? '' : 's'}, the pattern binds ${p.binds.length}`, p.span);
              p.binds = null;
            }
            if (p.binds?.some(b => b) && patLists[ai].length > 1) {
              this.err('E022', 'an arm with several patterns cannot bind names', p.span, "split the arm, or use '_'");
              p.binds = null;
            }
          }
        } else {
          if (matchable && p.ty !== st) this.mismatch(st, p.ty, p.span, 'in match pattern');
          else key = `l${p.value}`;
        }
        if (key) {
          if (wild || seen.has(key)) this.warn('W010', 'unreachable pattern', p.span);
          seen.add(key);
        }
      }
      out.push(runArm(ai));
    }

    const exhaustive = wild
      || (st === 'bool' && seen.has('ltrue') && seen.has('lfalse'))
      || (!!decl && decl.variants.every((_, i) => seen.has(`v${i}`)));
    if (matchable && !exhaustive) {
      const missing = decl ? decl.variants.filter((_, i) => !seen.has(`v${i}`)).map(v => `${decl.name}.${v.name}`) : [];
      this.err('E020', 'non-exhaustive match', scrut.span, missing.length ? `missing: ${missing.join(', ')}` : "add a '_' arm");
    }
    return { tmp, out, exhaustive };
  }

  fieldOf(ot: Type, name: string, nameSpan: Span, objSpan: Span): { ty: Type; idx: number } | null {
    if (ot === 'error') return null;
    if (!isStruct(ot)) {
      this.err('E019', `cannot access field '${name}' on a value of type ${ot}`, objSpan);
      return null;
    }
    const decl = this.structs.get(structName(ot));
    if (!decl) return null; // unknown type, already reported where it was written
    const idx = decl.fields.findIndex(f => f.name === name);
    if (idx < 0) {
      this.err('E019', `struct '${decl.name}' has no field '${name}'`, nameSpan, closestHint(name, decl.fields.map(f => f.name)));
      return null;
    }
    return { ty: decl.fields[idx].ty, idx };
  }

  negativeIndex(idx: Expr) {
    if (idx.k === 'unary' && idx.op === '-' && idx.arg.k === 'int' && idx.arg.value > 0) {
      this.err('E014', 'array index is negative, this always fails at runtime', idx.span);
    }
  }

  cond(e: Expr, what: string) {
    const t = this.expr(e);
    if (t !== 'bool' && t !== 'error') {
      this.err('E011', `the condition of '${what}' must be bool, found ${t}`, e.span, t === 'int' ? 'compare explicitly, e.g. x != 0' : undefined);
    }
    if (e.k === 'bool' && !(what === 'while' && e.value)) {
      this.warn('W004', `condition is always ${e.value}`, e.span);
    }
  }

  mismatch(want: Type, got: Type, span: Span, ctx = '') {
    let hint: string | undefined;
    if (want === 'float' && got === 'int') hint = 'convert with float(x)';
    else if (want === 'int' && got === 'float') hint = 'convert with int(x), which truncates';
    else if (want === 'string') hint = 'convert with str(x)';
    this.err('E003', `type mismatch${ctx ? ' ' + ctx : ''}: expected ${want}, found ${got}`, span, hint);
  }

  undefinedVar(name: string, span: Span) {
    const names: string[] = [];
    for (let s: Scope | null = this.scope; s; s = s.parent) names.push(...s.vars.keys());
    const sug = closest(name, names);
    this.err('E001', `cannot find variable '${name}'`, span, sug ? `did you mean '${sug}'?` : undefined);
  }

  expr(e: Expr, want?: Type): Type {
    const cached = this.keep.get(e);
    if (cached !== undefined) return cached;
    const t = this.expr0(e, want);
    // a value of an implementing type is accepted where `dyn Trait` is expected
    if (want && t !== want && isEnum(want)) {
      const dt = this.dynByEnum.get(want.slice(1));
      const idx = dt ? dt.variants.findIndex(v => v.type === t) : -1;
      if (dt && idx >= 0) {
        const inner = { ...e } as Expr;
        Object.assign(e, { k: 'enumctor', enumName: dt.enumName, variant: dt.variants[idx].variant, idx, args: [inner] });
        e.ty = want;
        return want;
      }
    }
    e.ty = t;
    return t;
  }

  expr0(e: Expr, want?: Type): Type {
    switch (e.k) {
      case 'int': return 'int';
      case 'float': return 'float';
      case 'str': return 'string';
      case 'bool': return 'bool';
      case 'enumval': return ('#' + e.enumName) as Type;
      case 'fnref': return e.ty; // only produced by the 'var' case below
      case 'lambda': return this.lambda(e);
      case 'matchx': return this.matchExpr(e, want);
      case 'mcall': return this.methodCall(e, want);
      case 'enumctor': return ('#' + e.enumName) as Type;

      case 'var': {
        const sym = this.scope.lookup(e.name);
        if (!sym) {
          if (this.generics.has(e.name)) {
            this.err('E024', `generic function '${e.name}' cannot be used as a value`, e.span, 'call it directly so the type parameters can be inferred');
            return 'error';
          }
          const fn = this.fns.get(e.name);
          if (fn) {
            fn.used = true;
            Object.assign(e, { k: 'fnref', fn });
            return fnType(fn.params, fn.ret);
          }
          this.undefinedVar(e.name, e.span);
          return 'error';
        }
        e.sym = sym;
        sym.used = true;
        if (sym.box && !e.raw) {
          // reads of a shared var go through its cell
          const cell: Expr = { k: 'var', name: e.name, span: e.span, ty: sym.ty, sym, raw: true };
          Object.assign(e, { k: 'index', arr: cell, idx: { k: 'int', value: 0, span: e.span, ty: 'int' } });
          return sym.box;
        }
        return sym.ty;
      }

      case 'unary': {
        const t = this.expr(e.arg);
        if (t === 'error') return 'error';
        if (e.op === '-') {
          if (isNumeric(t)) return t;
          this.err('E003', `cannot negate a value of type ${t}`, e.span);
          return 'error';
        }
        if (t === 'bool') return 'bool';
        this.err('E003', `'!' needs a bool, found ${t}`, e.span);
        return 'error';
      }

      case 'binary': return this.binary(e);

      case 'array': {
        if (e.elems.length === 0) {
          if (want && isArray(want)) return want;
          this.err('E013', 'cannot infer the type of an empty array', e.span, 'annotate the target, e.g. let xs: int[] = [];');
          return 'error';
        }
        const wantElem = want && isArray(want) ? elemOf(want) : undefined;
        // later elements are checked against the first typed one, so [[1], []] works
        let w = wantElem;
        const tys: Type[] = [];
        for (const x of e.elems) {
          const t = this.expr(x, w);
          tys.push(t);
          if (!w && t !== 'error' && t !== 'void') w = t;
        }
        const first = tys.find(t => t !== 'error');
        if (!first) return 'error';
        if (first === 'void') {
          this.err('E010', 'a function that returns nothing cannot be used as a value', e.elems[tys.indexOf(first)].span);
          return 'error';
        }
        let ok = true;
        tys.forEach((t, i) => {
          if (t !== 'error' && t !== first) {
            this.mismatch(first, t, e.elems[i].span, 'in array literal');
            ok = false;
          }
        });
        return ok ? ((first + '[]') as Type) : 'error';
      }

      case 'field': {
        if (e.obj.k === 'var' && !this.scope.lookup(e.obj.name) && (this.enums.has(e.obj.name) || this.enumTemplates.has(e.obj.name))) return this.enumValue(e, want);
        const ot = this.expr(e.obj);
        const fld = this.fieldOf(ot, e.name, e.nameSpan, e.obj.span);
        if (!fld) return 'error';
        e.idx = fld.idx;
        return fld.ty;
      }

      case 'structlit': {
        const pre = new Map<FieldInit, Type>();
        const tmpl = this.structTemplates.get(e.name);
        if (tmpl) {
          const binds = new Map<string, Type>();
          const params = new Set(tmpl.typeParams!);
          const info = want && isStruct(want) ? this.structInst.get(structName(want)) : undefined;
          if (info && info.tmpl === tmpl.name) tmpl.typeParams!.forEach((p, i) => binds.set(p, info.args[i]));
          for (const f of e.fields) {
            const fd = tmpl.fields.find(d => d.name === f.name);
            if (!fd) continue;
            const t = this.expr(f.value, fd.ty.includes('@') && info ? this.canon(replaceVars(fd.ty, binds), f.nameSpan) as Type : undefined);
            pre.set(f, t);
            unify(fd.ty, t, params, binds, this.structInst);
          }
          const missingParam = tmpl.typeParams!.find(p => !binds.has(p));
          if (missingParam) {
            if ([...pre.values()].includes('error')) return 'error';
            this.err('E024', `cannot infer type parameter '${missingParam}' of struct '${e.name}'`, e.nameSpan, 'no field mentions it');
            return 'error';
          }
          const inst = this.structInstance(e.name, tmpl.typeParams!.map(p => binds.get(p)!), e.nameSpan);
          if (!inst) return 'error';
          e.name = inst;
        }
        const decl = this.structs.get(e.name);
        this.access('struct', e.name, decl, e.nameSpan);
        if (!decl) {
          const sug = closest(e.name, this.structs.keys());
          this.err('E016', `unknown struct '${e.name}'`, e.nameSpan, sug ? `did you mean '${sug}'?` : undefined);
          e.fields.forEach(f => this.expr(f.value));
          return 'error';
        }
        const seen = new Set<string>();
        for (const f of e.fields) {
          const idx = decl.fields.findIndex(d => d.name === f.name);
          if (idx < 0) {
            this.err('E018', `struct '${e.name}' has no field '${f.name}'`, f.nameSpan, closestHint(f.name, decl.fields.map(d => d.name)));
            this.expr(f.value);
            continue;
          }
          f.idx = idx;
          if (seen.has(f.name)) this.err('E018', `field '${f.name}' is given twice`, f.nameSpan);
          seen.add(f.name);
          const wantTy = decl.fields[idx].ty;
          const t = pre.get(f) ?? this.expr(f.value, wantTy);
          if (t === 'void') this.err('E010', 'a function that returns nothing cannot be used as a value', f.value.span);
          else if (t !== 'error' && t !== wantTy) this.mismatch(wantTy, t, f.value.span, `in field '${f.name}' of '${e.name}'`);
        }
        const missing = decl.fields.filter(d => !seen.has(d.name)).map(d => d.name);
        if (missing.length) this.err('E018', `missing field${missing.length > 1 ? 's' : ''} ${missing.map(m => `'${m}'`).join(', ')} in '${e.name}'`, e.span);
        return ('@' + e.name) as Type;
      }

      case 'index': {
        const at = this.expr(e.arr);
        const it = this.expr(e.idx);
        if (it !== 'error' && it !== 'int') this.err('E003', `array index must be int, found ${it}`, e.idx.span);
        this.negativeIndex(e.idx);
        if (at === 'error') return 'error';
        if (!isArray(at)) {
          this.err('E003', `cannot index a value of type ${at}`, e.arr.span);
          return 'error';
        }
        return elemOf(at);
      }

      case 'call': return this.call(e);
    }
  }

  binary(e: Extract<Expr, { k: 'binary' }>): Type {
    const a = this.expr(e.l);
    const b = this.expr(e.r);
    const cmp = e.op === '==' || e.op === '!=' || e.op === '<' || e.op === '<=' || e.op === '>' || e.op === '>=';
    const bad = a === 'error' || b === 'error';

    if (e.op === '/' || e.op === '%') {
      if (e.r.k === 'int' && e.r.value === 0) {
        this.err('E012', e.op === '/' ? 'division by zero' : 'modulo by zero', e.r.span);
      }
    }
    if ((e.op === '==' || e.op === '!=' || e.op === '<' || e.op === '>') && e.l.k === 'var' && e.r.k === 'var' && e.l.sym && e.l.sym === e.r.sym) {
      this.warn('W006', `comparing '${e.l.name}' with itself`, e.span);
    }

    if (bad) return cmp || e.op === '&&' || e.op === '||' ? 'bool' : 'error';

    const opErr = (msg: string, hint?: string): Type => {
      this.err('E003', msg, e.span, hint);
      return cmp ? 'bool' : 'error';
    };
    const sameHint = (a === 'int' && b === 'float') || (a === 'float' && b === 'int')
      ? 'int and float do not mix; convert one side with float(x) or int(x)' : undefined;

    switch (e.op) {
      case '+':
        if (a === 'string' && b === 'string') return 'string';
        if (isNumeric(a) && a === b) return a;
        return opErr(`cannot apply '+' to ${a} and ${b}`, sameHint ?? (a === 'string' || b === 'string' ? 'convert with str(x) to concatenate' : undefined));
      case '-':
      case '*':
      case '/':
        if (isNumeric(a) && a === b) return a;
        return opErr(`cannot apply '${e.op}' to ${a} and ${b}`, sameHint);
      case '%':
        if (a === 'int' && b === 'int') return 'int';
        return opErr(`'%' works on int only, found ${a} and ${b}`);
      case '<': case '<=': case '>': case '>=':
        if ((isNumeric(a) || a === 'string') && a === b) return 'bool';
        return opErr(`cannot compare ${a} with ${b} using '${e.op}'`, sameHint);
      case '==': case '!=':
        if (a === b && isEnum(a) && this.isBoxed(a)) return opErr('enums with data cannot be compared with == or !=', 'use match');
        if (isFn(a) && a === b) return opErr('functions cannot be compared');
        if (a === b && a !== 'void' && !isRef(a)) return 'bool';
        if (a === b && isRef(a)) return opErr('arrays and structs cannot be compared with == or !=', 'compare the elements or fields one by one');
        return opErr(`cannot compare ${a} with ${b}`, sameHint);
      case '&&': case '||':
        if (a === 'bool' && b === 'bool') return 'bool';
        return opErr(`'${e.op}' needs bool operands, found ${a} and ${b}`);
    }
  }

  builtin(e: Extract<Expr, { k: 'call' }>, name: keyof typeof BUILTINS): Type {
    e.builtin = name;
    const tys = e.args.map(a => this.expr(a));
    const arity = BUILTINS[name].arity;
    const ret: Type = { print: 'void', str: 'string', int: 'int', float: 'float', len: 'int', push: 'void', pop: 'error', sqrt: 'float', abs: 'error', min: 'error', max: 'error', substr: 'string', find: 'int', split: 'string[]', byte: 'int', chr: 'string', join: 'string', trim: 'string', assert: 'void', read_line: 'string', at_eof: 'bool', exit: 'void', sort: 'void', reverse: 'void', contains: 'bool', slice: 'error' }[name] as Type;

    if (e.args.length !== arity) {
      this.err('E004', `'${name}' takes ${arity} argument${arity === 1 ? '' : 's'}, but ${e.args.length} ${e.args.length === 1 ? 'was' : 'were'} given`, e.span);
      return ret;
    }
    const [t0, t1, t2] = tys;
    if (t0 === 'void') {
      this.err('E010', 'a function that returns nothing cannot be used as a value', e.args[0].span);
      return ret;
    }
    const bad = (what: string) => this.err('E003', `'${name}' ${what}, found ${t0}`, e.args[0].span);
    if ((name === 'print' || name === 'str') && hasFn(t0)) {
      this.err('E003', `functions cannot be turned into text, found ${t0}`, e.args[0].span);
      return ret;
    }

    switch (name) {
      case 'print':
      case 'str':
        return ret;
      case 'int':
      case 'float':
        if (t0 !== 'error' && !isNumeric(t0)) bad('expects int or float');
        return ret;
      case 'len':
        if (t0 !== 'error' && t0 !== 'string' && !isArray(t0)) bad('expects a string or an array');
        return ret;
      case 'push':
        if (t0 === 'error') return ret;
        if (!isArray(t0)) { bad('expects an array as its first argument'); return ret; }
        if (t1 !== 'error' && t1 !== elemOf(t0)) this.mismatch(elemOf(t0), t1, e.args[1].span, `in argument 2 of 'push'`);
        return ret;
      case 'substr':
        if (t0 !== 'error' && t0 !== 'string') bad('expects a string as its first argument');
        if (t1 !== 'error' && t1 !== 'int') this.mismatch('int', t1, e.args[1].span, `in argument 2 of 'substr'`);
        if (t2 !== 'error' && t2 !== 'int') this.mismatch('int', t2, e.args[2].span, `in argument 3 of 'substr'`);
        return ret;
      case 'byte':
        if (t0 !== 'error' && t0 !== 'string') bad('expects a string as its first argument');
        if (t1 !== 'error' && t1 !== 'int') this.mismatch('int', t1, e.args[1].span, `in argument 2 of 'byte'`);
        return ret;
      case 'join':
        if (t0 !== 'error' && t0 !== 'string[]') bad('expects a string[] as its first argument');
        if (t1 !== 'error' && t1 !== 'string') this.mismatch('string', t1, e.args[1].span, `in argument 2 of 'join'`);
        return ret;
      case 'trim':
        if (t0 !== 'error' && t0 !== 'string') bad('expects a string');
        return ret;
      case 'read_line':
      case 'at_eof':
        return ret;
      case 'sort':
        if (t0 === 'error') return ret;
        if (t0 !== 'int[]' && t0 !== 'float[]' && t0 !== 'string[]') bad('expects an int[], float[] or string[]');
        return ret;
      case 'reverse':
        if (t0 !== 'error' && !isArray(t0)) bad('expects an array');
        return ret;
      case 'contains':
        if (t0 === 'error') return ret;
        if (t0 !== 'int[]' && t0 !== 'float[]' && t0 !== 'string[]' && t0 !== 'bool[]') { bad('expects an int[], float[], string[] or bool[]'); return ret; }
        if (t1 !== 'error' && t1 !== elemOf(t0)) this.mismatch(elemOf(t0), t1, e.args[1].span, `in argument 2 of 'contains'`);
        return ret;
      case 'slice':
        if (t1 !== 'error' && t1 !== 'int') this.mismatch('int', t1, e.args[1].span, `in argument 2 of 'slice'`);
        if (t2 !== 'error' && t2 !== 'int') this.mismatch('int', t2, e.args[2].span, `in argument 3 of 'slice'`);
        if (t0 === 'error') return 'error';
        if (!isArray(t0)) { bad('expects an array'); return 'error'; }
        return t0;
      case 'exit':
        if (t0 !== 'error' && t0 !== 'int') this.mismatch('int', t0, e.args[0].span, `in argument 1 of 'exit'`);
        return ret;
      case 'assert':
        if (t0 !== 'error' && t0 !== 'bool') this.mismatch('bool', t0, e.args[0].span, `in argument 1 of 'assert'`);
        if (t1 !== 'error' && t1 !== 'string') this.mismatch('string', t1, e.args[1].span, `in argument 2 of 'assert'`);
        return ret;
      case 'chr':
        if (t0 !== 'error' && t0 !== 'int') bad('expects an int');
        return ret;
      case 'find':
      case 'split':
        if (t0 !== 'error' && t0 !== 'string') bad('expects a string as its first argument');
        if (t1 !== 'error' && t1 !== 'string') this.mismatch('string', t1, e.args[1].span, `in argument 2 of '${name}'`);
        return ret;
      case 'sqrt':
        if (t0 !== 'error' && t0 !== 'float') bad('expects a float');
        return ret;
      case 'abs':
        if (t0 === 'error') return 'error';
        if (!isNumeric(t0)) { bad('expects int or float'); return 'error'; }
        return t0;
      case 'min':
      case 'max':
        if (t0 === 'error' || t1 === 'error') return t0 === 'error' ? t1 : t0;
        if (!isNumeric(t0)) { bad('expects int or float'); return 'error'; }
        if (t1 !== t0) { this.mismatch(t0, t1, e.args[1].span, `in argument 2 of '${name}'`); return t0; }
        return t0;
      case 'pop':
        if (t0 === 'error') return 'error';
        if (!isArray(t0)) { bad('expects an array'); return 'error'; }
        return elemOf(t0);
    }
  }

  lambda(e: Extract<Expr, { k: 'lambda' }>): Type {
    const f = e.fn;
    const ty = fnType(f.params.map(p => p.ty), f.ret);
    const used = new Set<string>();
    const declared = new Set<string>();
    for (const p of f.params) declared.add(p.name);
    namesIn(f.body, used, declared);

    // captured locals are copied in when the closure is created and arrive as extra trailing params
    for (const name of used) {
      if (declared.has(name)) continue;
      const outer = this.scope.lookup(name);
      if (!outer || outer.where === 'global') continue;
      if (outer.mutable && !outer.box) {
        this.err('E023', `a function value cannot capture '${name}' because it is declared with 'var'`, f.nameSpan, `copy it first: let ${name}_copy = ${name};`);
      }
      const ref: Expr = { k: 'var', name, span: f.nameSpan, ty: 'error', raw: outer.box !== undefined };
      this.expr(ref);
      e.caps.push(ref);
      f.params.push({ name, span: outer.span, ty: outer.ty, box: outer.box, mutable: outer.mutable, from: outer });
    }

    const saved = this.scope;
    this.scope = this.globals;
    this.analyzeFn(f);
    this.scope = saved;
    for (const p of f.params.slice(f.params.length - e.caps.length)) if (p.sym) p.sym.used = true;
    if (f.sym) f.sym.used = true;
    return ty;
  }

  // the type string a user-written type name stands for, same rule the parser uses
  typeOfName(name: string): Type | null {
    if (name === 'int' || name === 'float' || name === 'bool' || name === 'string') return name;
    if (this.enums.has(name)) return ('#' + name) as Type;
    if (this.structs.has(name)) return ('@' + name) as Type;
    return null;
  }

  checkTraits(prog: Program) {
    const pending: { d: FnDecl; im: object }[] = [];
    const failed = new Set<object>();
    for (const t of prog.traits) {
      if (this.traits.has(t.name)) this.err('E006', `trait '${t.name}' is already defined`, t.nameSpan);
      else this.traits.set(t.name, t);
    }
    for (const f of this.generics.values()) {
      for (const [param, list] of Object.entries(f.bounds ?? {})) {
        for (const tr of list) {
          if (!this.traits.has(tr)) this.err('E025', `unknown trait '${tr}' (bound of '${param}' in '${f.name}')`, f.nameSpan, closestHint(tr, [...this.traits.keys()]));
        }
      }
    }
    for (const im of prog.impls) {
      const tr = this.traits.get(im.trait);
      const ty = this.typeOfName(im.type);
      if (!tr) {
        this.err('E025', `unknown trait '${im.trait}'`, im.span, closestHint(im.trait, [...this.traits.keys()]));
        continue;
      }
      if (!ty) {
        this.err('E016', `unknown type '${im.type}'`, im.span);
        failed.add(im);
        continue;
      }
      let ok = true;
      for (const m of tr.methods) {
        let fn = this.fns.get(`${im.type}$${m.name}`);
        if (!fn && m.body) {
          const d: FnDecl = structuredClone({
            k: 'fn' as const, span: m.span, name: `${im.type}$${m.name}`, nameSpan: m.span, ret: m.ret, body: m.body, nlocals: 0,
            params: [...(m.hasSelf ? [{ name: 'self', span: m.span, ty }] : []), ...m.params],
          });
          this.registerLambdas(d);
          this.prog.fns.push(d);
          this.declareFn(d);
          d.sym!.used = true;
          pending.push({ d, im });
          fn = d.sym;
        }
        if (!fn) {
          this.err('E026', `'impl ${im.trait} for ${im.type}' is missing method '${m.name}'`, im.span, `add: fn ${m.name}(${m.hasSelf ? 'self' : ''}...)`);
          ok = false;
          continue;
        }
        const hasSelf = fn.decl.params[0]?.name === 'self';
        const rest = hasSelf ? fn.params.slice(1) : fn.params;
        if (hasSelf !== m.hasSelf || rest.length !== m.params.length || rest.some((p, i) => p !== m.params[i].ty) || fn.ret !== m.ret) {
          const sig = `${m.hasSelf ? ['self', ...m.params.map(p => p.ty)] : m.params.map(p => p.ty)}`;
          this.err('E026', `method '${m.name}' of '${im.type}' does not match trait '${im.trait}': expected (${sig}) -> ${m.ret}`, fn.decl.nameSpan);
          ok = false;
        }
      }
      if (ok) this.impls.add(`${im.trait} for ${ty}`);
      else failed.add(im);
    }
    // default methods are checked once every impl has been declared
    for (const { d, im } of pending) {
      if (failed.has(im)) continue;
      const saved = this.scope;
      this.scope = this.globals;
      this.analyzeFn(d);
      this.scope = saved;
    }
    this.dynWrappers(prog, failed);
  }

  // `dyn Trait` is a closed-world enum: one variant per impl, dispatch is a match over them
  synthDyn(prog: Program) {
    const typeStr = (n: string): Type => (['int', 'float', 'bool', 'string'].includes(n) ? n : prog.enums.some(e => e.name === n) ? '#' + n : '@' + n) as Type;
    for (const t of prog.traits) {
      const impls = prog.impls.filter(i => i.trait === t.name);
      if (!impls.length || this.dynTraits.has(t.name)) continue;
      const enumName = `${t.name}__dyn`;
      const variants = impls.map(i => ({ variant: `As${i.type}`, type: typeStr(i.type), implType: i.type, span: i.span }));
      this.dynTraits.set(t.name, { enumName, variants });
      this.dynByEnum.set(enumName, { enumName, variants });
      prog.enums.push({
        k: 'enum', span: t.nameSpan, name: enumName, nameSpan: t.nameSpan,
        variants: variants.map(v => ({ name: v.variant, span: v.span, payload: [v.type] })),
      });
    }
  }

  // Shape__dyn$area(self, ...) { match self { AsCircle(x) => return Circle$area(x, ...), ... } }
  dynWrappers(prog: Program, failed: Set<object>) {
    for (const t of prog.traits) {
      const dt = this.dynTraits.get(t.name);
      if (!dt || prog.impls.some(i => i.trait === t.name && failed.has(i))) continue;
      const selfTy = ('#' + dt.enumName) as Type;
      const made: FnDecl[] = [];
      for (const m of t.methods) {
        if (!m.hasSelf) continue;
        const sp = m.span;
        const v = (name: string): Expr => ({ k: 'var', name, span: sp, ty: 'error' });
        const arms = dt.variants.map(variant => {
          const call: Expr = { k: 'call', name: `${variant.implType}$${m.name}`, nameSpan: sp, args: [v('x'), ...m.params.map(p => v(p.name))], span: sp, ty: 'error' };
          const body: Stmt[] = m.ret === 'void' ? [{ k: 'expr', span: sp, e: call }] : [{ k: 'return', span: sp, value: call }];
          return {
            pats: [{ k: 'variant' as const, span: sp, name: variant.variant, idx: -1, binds: [{ name: 'x', span: sp }], tys: [], boxed: false }],
            body, span: sp,
          };
        });
        const d: FnDecl = {
          k: 'fn', span: sp, name: `${dt.enumName}$${m.name}`, nameSpan: sp, ret: m.ret, nlocals: 0,
          params: [{ name: 'self', span: sp, ty: selfTy }, ...m.params.map(p => ({ ...p }))],
          body: [{ k: 'match', span: sp, scrut: v('self'), arms, tmp: -1 }],
        };
        prog.fns.push(d);
        this.declareFn(d);
        d.sym!.used = true;
        made.push(d);
      }
      this.impls.add(`${t.name} for ${selfTy}`);
      for (const d of made) {
        const saved = this.scope;
        this.scope = this.globals;
        this.analyzeFn(d);
        this.scope = saved;
      }
    }
  }

  // `geometry.dist(...)`: the parser drops the qualifier, here we make sure the item really lives in that file
  checkQualified(prog: Program) {
    for (const q of prog.qualified) {
      const decl = this.fns.get(q.name)?.decl ?? this.generics.get(q.name) ?? this.structs.get(q.name) ?? this.structTemplates.get(q.name)
        ?? this.enums.get(q.name) ?? this.enumTemplates.get(q.name);
      if (!decl) {
        this.err('E028', `module '${q.module}' has no item '${q.name}'`, q.span);
        continue;
      }
      const home = this.fileOf(decl.nameSpan);
      if (home && home !== `${q.module}.lum`) this.err('E028', `'${q.name}' is declared in ${home}, not in module '${q.module}'`, q.span);
    }
  }

  registerLambdas(d: FnDecl) {
    const ls: Extract<Expr, { k: 'lambda' }>[] = [];
    lambdasIn(d.body, ls);
    ls.forEach(l => {
      l.fn.name = `lambda$g${this.ninst++}`;
      this.prog.fns.push(l.fn);
      this.declareFn(l.fn);
    });
  }

  genericCall(e: Extract<Expr, { k: 'call' }>, gen: FnDecl): Type {
    const tys = e.args.map(a => this.expr(a));
    if (e.args.length !== gen.params.length) {
      this.err('E004', `'${e.name}' takes ${gen.params.length} argument${gen.params.length === 1 ? '' : 's'}, but ${e.args.length} ${e.args.length === 1 ? 'was' : 'were'} given`, e.span);
      return 'error';
    }
    if (tys.includes('error')) return 'error';
    this.calledGenerics.add(gen.name);
    const names = gen.typeParams!;
    const binds = new Map<string, Type>();
    gen.params.forEach((p, i) => unify(p.ty, tys[i], new Set(names), binds, this.structInst));
    const missing = names.find(n => !binds.has(n));
    if (missing) {
      this.err('E024', `cannot infer type parameter '${missing}' of '${e.name}'`, e.nameSpan, 'no argument mentions it');
      return 'error';
    }

    for (const [param, list] of Object.entries(gen.bounds ?? {})) {
      for (const tr of list) {
        const ty = binds.get(param)!;
        if (this.traits.has(tr) && !this.impls.has(`${tr} for ${ty}`)) {
          this.err('E025', `type ${ty} does not implement trait '${tr}'`, e.nameSpan, `'${param}' of '${e.name}' requires it; add: impl ${tr} for ${ty.replace(/^[@#]/, '')} { ... }`);
          return 'error';
        }
      }
    }

    const key = `${e.name}<${names.map(n => binds.get(n)).join(',')}>`;
    let sym = this.insts.get(key);
    if (!sym) {
      const d = structuredClone(gen);
      d.typeParams = undefined;
      d.name = `${gen.name}$${this.insts.size}`;
      mapTypes(d, t => replaceVars(t, binds));
      mapTypes(d, (t, o) => this.canon(t, (o.span as Span | undefined) ?? e.span));
      this.registerLambdas(d);
      this.prog.fns.push(d);
      this.declareFn(d);
      sym = d.sym!;
      this.insts.set(key, sym);
      const saved = this.scope;
      this.scope = this.globals;
      this.analyzeFn(d);
      this.scope = saved;
    }
    return this.checkUserCall(e, sym, tys);
  }

  call(e: Extract<Expr, { k: 'call' }>): Type {
    if (isBuiltin(e.name)) return this.builtin(e, e.name);

    const gen = this.generics.get(e.name);
    if (gen && !this.scope.lookup(e.name)) return this.genericCall(e, gen);

    // a local of function type wins over a global function with the same name
    const local = e.callee ? undefined : this.scope.lookup(e.name);
    if (local && isFn(local.ty)) {
      e.callee = { k: 'var', name: e.name, span: e.nameSpan, ty: 'error' };
    }
    if (e.callee) {
      const ct = this.expr(e.callee);
      if (ct === 'error') {
        e.args.forEach(a => this.expr(a));
        return 'error';
      }
      if (!isFn(ct)) {
        e.args.forEach(a => this.expr(a));
        this.err('E003', `cannot call a value of type ${ct}`, e.callee.span);
        return 'error';
      }
      const sig = fnSig(ct);
      const tys = e.args.map((a, i) => this.expr(a, sig.params[i]));
      const sym: FnSym = { name: e.name, params: sig.params, ret: sig.ret, index: -1, span: e.nameSpan, used: true, decl: null as unknown as FnDecl };
      return this.checkUserCall(e, sym, tys);
    }

    const fn = this.fns.get(e.name);
    const argTys = e.args.map((a, i) => this.expr(a, fn?.params[i]));

    if (!fn) {
      const v = this.scope.lookup(e.name);
      if (v) {
        this.err('E002', `'${e.name}' is a variable, not a function`, e.nameSpan);
      } else {
        const sug = closest(e.name, [...this.fns.keys(), ...Object.keys(BUILTINS)]);
        this.err('E002', `cannot find function '${e.name}'`, e.nameSpan, sug ? `did you mean '${sug}'?` : undefined);
      }
      return 'error';
    }

    return this.checkUserCall(e, fn, argTys);
  }

  checkUserCall(e: Extract<Expr, { k: 'call' }>, fn: FnSym, argTys: Type[]): Type {
    e.fn = fn;
    fn.used = true;
    if (fn.index >= 0 && !fn.name.includes('$')) this.access('function', fn.name, fn.decl, e.nameSpan);
    if (e.args.length !== fn.params.length) {
      this.err('E004', `'${e.name}' takes ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}, but ${e.args.length} ${e.args.length === 1 ? 'was' : 'were'} given`, e.span);
    } else {
      e.args.forEach((a, i) => {
        const t = argTys[i];
        if (t === 'void') this.err('E010', 'a function that returns nothing cannot be used as a value', a.span);
        else if (t !== 'error' && t !== fn.params[i]) this.mismatch(fn.params[i], t, a.span, `in argument ${i + 1} of '${e.name}'`);
      });
    }
    return fn.ret;
  }
}

export function analyze(prog: Program, segments: Segment[] = []): Diagnostic[] {
  const a = new Analyzer();
  a.segments = segments;
  a.run(prog);
  return a.diags;
}
