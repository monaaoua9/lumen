import type { Diagnostic, Severity, Span } from './diagnostics.ts';
import type { EnumDecl, Expr, FnDecl, FnSym, Pat, Program, Stmt, StructDecl, VarSym } from './ast.ts';
import { BUILTINS, elemOf, isArray, isBuiltin, isNumeric, isEnum, isRef, isStruct, structName } from './types.ts';
import type { Type } from './types.ts';

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

interface FnCtx {
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
  ctx: FnCtx = { ret: 'void', nlocals: 0, isMain: true, name: '<main>' };
  nglobals = 0;
  loops: { sawBreak: boolean }[] = [];
  allVars: VarSym[] = [];

  report(severity: Severity, code: string, message: string, span: Span, hint?: string) {
    this.diags.push({ severity, code, message: message.replaceAll('@', ''), span, hint });
  }
  err(code: string, message: string, span: Span, hint?: string) { this.report('error', code, message, span, hint); }
  warn(code: string, message: string, span: Span, hint?: string) { this.report('warning', code, message, span, hint); }

  run(prog: Program) {
    this.declareEnums(prog.enums);
    this.declareStructs(prog.structs);
    for (const f of prog.fns) this.declareFn(f);

    this.analyzeBlockBody(prog.body);

    for (const v of this.allVars) this.lintVar(v);
    for (const f of this.fns.values()) {
      if (!f.used) this.warn('W005', `function '${f.name}' is never called`, f.decl.nameSpan);
    }

    prog.nlocals = this.ctx.nlocals;
    prog.nglobals = this.nglobals;
    this.diags.sort((a, b) => a.span.start - b.span.start);
  }

  declareEnums(list: EnumDecl[]) {
    for (const d of list) {
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

  declareStructs(list: StructDecl[]) {
    for (const s of list) {
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

  // struct names are only known after parsing, so every written type goes through here
  checkType(t: Type, span: Span) {
    const base = isArray(t) ? elemOf(t) : t;
    if (isEnum(base) && !this.enums.has(base.slice(1))) {
      this.err('E016', `unknown type '${base.slice(1)}'`, span);
    } else if (isStruct(base) && !this.structs.has(structName(base))) {
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
    if (v.name.startsWith('_')) return;
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
    this.ctx = { ret: f.ret, nlocals: 0, isMain: false, name: f.name };
    this.loops = [];

    this.withScope(() => {
      for (const p of f.params) p.sym = this.declareVar(p.name, p.ty, false, p.span, true);
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
        } else if (s.annot && t !== 'error' && t !== s.annot) {
          this.mismatch(s.annot, t, s.init.span);
        }
        // declared after the initializer so `let x = x + 1` sees the outer x
        s.sym = this.declareVar(s.name, ty, s.mutable, s.nameSpan);
        return NEXT;
      }

      case 'assign': {
        const sym = this.scope.lookup(s.name);
        const t = this.expr(s.value, sym?.ty);
        if (!sym) {
          this.undefinedVar(s.name, s.nameSpan);
          return NEXT;
        }
        s.sym = sym;
        if (!sym.mutable) {
          this.err('E005', `cannot assign to '${s.name}' because it is not declared with 'var'`, s.nameSpan,
            sym.isParam ? 'parameters are immutable; copy it into a local var first' : `declare it with 'var ${s.name} = ...'`);
        }
        sym.assigned = true;
        if (t === 'void') this.err('E010', 'a function that returns nothing cannot be used as a value', s.value.span);
        else if (t !== 'error' && sym.ty !== 'error' && t !== sym.ty) this.mismatch(sym.ty, t, s.value.span);
        if (s.value.k === 'var' && s.value.name === s.name) this.warn('W009', `'${s.name}' is assigned to itself`, s.span);
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
  enumValue(e: Extract<Expr, { k: 'field' }>): Type {
    const decl = this.enums.get((e.obj as Extract<Expr, { k: 'var' }>).name)!;
    const idx = decl.variants.findIndex(v => v.name === e.name);
    if (idx < 0) {
      this.err('E021', `enum '${decl.name}' has no variant '${e.name}'`, e.nameSpan, closestHint(e.name, decl.variants.map(v => v.name)));
      return 'error';
    }
    Object.assign(e, { k: 'enumval', enumName: decl.name, variant: e.name, idx });
    return ('#' + decl.name) as Type;
  }

  matchStmt(s: Extract<Stmt, { k: 'match' }>): Flow {
    const r = this.matchCore(s.scrut, s.arms.map(a => a.pats), i => this.withScope(() => this.block(s.arms[i].body)));
    s.tmp = r.tmp;
    const all = (k: 'diverges' | 'returns') => r.out.length > 0 && r.exhaustive && r.out.every(f => f[k]);
    return { diverges: all('diverges'), returns: all('returns') };
  }

  matchExpr(e: Extract<Expr, { k: 'matchx' }>, want?: Type): Type {
    const r = this.matchCore(e.scrut, e.arms.map(a => a.pats), i => this.expr(e.arms[i].value, want));
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
    const decl = this.structs.get(structName(ot))!;
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
    const t = this.expr0(e, want);
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
      case 'matchx': return this.matchExpr(e, want);

      case 'var': {
        const sym = this.scope.lookup(e.name);
        if (!sym) {
          this.undefinedVar(e.name, e.span);
          return 'error';
        }
        e.sym = sym;
        sym.used = true;
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
        const tys = e.elems.map(x => this.expr(x, wantElem));
        const first = tys.find(t => t !== 'error');
        if (!first) return 'error';
        if (isArray(first) || first === 'void') {
          this.err('E013', first === 'void' ? 'a function that returns nothing cannot be used as a value' : 'nested arrays are not supported', e.elems[tys.indexOf(first)].span);
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
        if (e.obj.k === 'var' && !this.scope.lookup(e.obj.name) && this.enums.has(e.obj.name)) return this.enumValue(e);
        const ot = this.expr(e.obj);
        const fld = this.fieldOf(ot, e.name, e.nameSpan, e.obj.span);
        if (!fld) return 'error';
        e.idx = fld.idx;
        return fld.ty;
      }

      case 'structlit': {
        const decl = this.structs.get(e.name);
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
          const want = decl.fields[idx].ty;
          const t = this.expr(f.value, want);
          if (t === 'void') this.err('E010', 'a function that returns nothing cannot be used as a value', f.value.span);
          else if (t !== 'error' && t !== want) this.mismatch(want, t, f.value.span, `in field '${f.name}' of '${e.name}'`);
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
        if (isNumeric(a) && a === b) return 'bool';
        return opErr(`cannot compare ${a} with ${b} using '${e.op}'`, sameHint);
      case '==': case '!=':
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
    const ret: Type = { print: 'void', str: 'string', int: 'int', float: 'float', len: 'int', push: 'void', pop: 'error' }[name] as Type;

    if (e.args.length !== arity) {
      this.err('E004', `'${name}' takes ${arity} argument${arity === 1 ? '' : 's'}, but ${e.args.length} ${e.args.length === 1 ? 'was' : 'were'} given`, e.span);
      return ret;
    }
    const [t0, t1] = tys;
    if (t0 === 'void') {
      this.err('E010', 'a function that returns nothing cannot be used as a value', e.args[0].span);
      return ret;
    }
    const bad = (what: string) => this.err('E003', `'${name}' ${what}, found ${t0}`, e.args[0].span);

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
      case 'pop':
        if (t0 === 'error') return 'error';
        if (!isArray(t0)) { bad('expects an array'); return 'error'; }
        return elemOf(t0);
    }
  }

  call(e: Extract<Expr, { k: 'call' }>): Type {
    if (isBuiltin(e.name)) return this.builtin(e, e.name);

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

    e.fn = fn;
    fn.used = true;
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

export function analyze(prog: Program): Diagnostic[] {
  const a = new Analyzer();
  a.run(prog);
  return a.diags;
}
