import type { Diagnostic, Segment, Span } from './diagnostics.ts';
import type { BinOp, EnumDecl, Expr, FieldInit, FnDecl, ImplFor, MatchArm, Param, Pat, Program, Qualified, Stmt, StructDecl, StructField, TraitDecl } from './ast.ts';
import { lex } from './lexer.ts';
import type { Token } from './lexer.ts';
import { arrayOf, enumType, fnType, structType, typeFromName } from './types.ts';
import type { Elem, Type } from './types.ts';

class Bail extends Error {}

interface LoopInfo {
  label?: string;
  id: number;
  brk: boolean;
  cnt: boolean;
  crossing: Set<LoopInfo>;
}

function hasCall(e: Expr): boolean {
  switch (e.k) {
    case 'call': return true;
    case 'unary': return hasCall(e.arg);
    case 'binary': return hasCall(e.l) || hasCall(e.r);
    case 'index': return hasCall(e.arr) || hasCall(e.idx);
    case 'array': return e.elems.some(hasCall);
    case 'field': return hasCall(e.obj);
    case 'mcall': return true;
    case 'blockx': return true;
    case 'matchx': return hasCall(e.scrut) || e.arms.some(a => hasCall(a.value) || (a.guard !== undefined && hasCall(a.guard)));
    case 'structlit': return e.fields.some(f => hasCall(f.value));
    default: return false;
  }
}

// binding power per binary operator, higher binds tighter
const PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

const COMPOUND: Record<string, BinOp> = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%' };

class Parser {
  toks: Token[];
  pos = 0;
  diags: Diagnostic[];
  fns: FnDecl[] = [];
  lambdas = 0;
  recs: { name: string; mangled: string; used: boolean }[] = [];
  hoisted: Stmt[] = [];
  queue: Stmt[] = []; // statements a desugaring adds right after the one being returned
  structs: StructDecl[] = [];
  traits: TraitDecl[] = [];
  qualified: Qualified[] = [];
  modules = new Set<string>(); // names usable as `module.item`, from the import lines
  impls: ImplFor[] = [];
  enums: EnumDecl[] = [];
  enumNames = new Set<string>();
  forId = 0;
  noStruct = false; // `if x {` must not parse as a struct literal
  depth = 0; // block nesting, fn is only legal at 0

  // top-level names per file, only filled when several files are bundled
  segments: Segment[];
  src = ''; // the text being parsed, assert(cond) quotes its condition from it
  declared = new Map<string, Map<string, string>>(); // file -> name -> fn | struct | enum
  clash = new Set<string>(); // names declared in more than one file
  lets = new Map<string, Set<string>>(); // file -> top-level let/var names
  letClash = new Set<string>(); // top-level let/var names declared in more than one file

  constructor(toks: Token[], diags: Diagnostic[], segments: Segment[] = []) {
    this.toks = toks;
    this.diags = diags;
    this.segments = segments;
    if (segments.length > 1) this.scanDecls();
    // enums may be used before they are declared, so find their names up front
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].kind === 'enum' && toks[i + 1].kind === 'ident') this.enumNames.add(toks[i + 1].text);
      if (toks[i].kind === 'ident' && toks[i].text === 'import' && toks[i + 1].kind === 'string') {
        this.modules.add(String(toks[i + 1].value).replace(/^.*[\\/]/, '').replace(/\.lum$/, ''));
      }
    }
  }

  scanDecls() {
    const owners = new Map<string, number>();
    const letOwners = new Map<string, number>();
    let depth = 0;
    for (let i = 0; i < this.toks.length - 1; i++) {
      const t = this.toks[i];
      if (t.kind === '{') depth++;
      else if (t.kind === '}') depth--;
      else if (depth === 0 && (t.kind === 'let' || t.kind === 'var') && this.toks[i + 1].kind === 'ident') {
        const file = this.fileOf(t);
        if (!this.lets.has(file)) this.lets.set(file, new Set());
        const names = this.lets.get(file)!;
        const name = this.toks[i + 1].text;
        if (!names.has(name)) letOwners.set(name, (letOwners.get(name) ?? 0) + 1);
        names.add(name);
      } else if (depth === 0 && (t.kind === 'fn' || t.kind === 'struct' || t.kind === 'enum' || t.kind === 'trait') && this.toks[i + 1].kind === 'ident') {
        const file = this.fileOf(t);
        const name = this.toks[i + 1].text;
        if (!this.declared.has(file)) this.declared.set(file, new Map());
        if (!this.declared.get(file)!.has(name)) owners.set(name, (owners.get(name) ?? 0) + 1);
        this.declared.get(file)!.set(name, t.kind);
      }
    }
    for (const [name, n] of owners) if (n > 1) this.clash.add(name);
    for (const [name, n] of letOwners) if (n > 1) this.letClash.add(name);
  }

  fileOf(t: Token): string {
    return this.segments.find(s => t.span.start >= s.start && t.span.start <= s.end)?.name ?? '';
  }

  // two files may declare the same top-level name: the internal name then carries the module, `geometry$dist`
  modName(file: string): string {
    return file.replace(/\.lum$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  }

  // the name a reference or declaration in the current file means
  rn(t: Token): Token {
    if (!this.clash.has(t.text)) return t;
    const file = this.fileOf(t);
    if (this.declared.get(file)?.has(t.text)) return { ...t, text: `${this.modName(file)}$${t.text}` };
    this.diags.push({ severity: 'error', code: 'P006', message: `'${t.text}' is declared in several modules, write module.${t.text}`, span: t.span });
    return t;
  }

  // a global let that two files both declare: every use of the name inside the declaring file carries the module
  vn(t: Token): Token {
    if (!this.letClash.has(t.text)) return t;
    const file = this.fileOf(t);
    return this.lets.get(file)?.has(t.text) ? { ...t, text: `${this.modName(file)}$${t.text}` } : t;
  }

  // a trait name in a bound or `dyn`, optionally written module.Trait
  traitRef(): Token {
    const t = this.expect('ident', 'a trait name');
    if (this.modules.has(t.text) && this.at('.')) {
      this.next();
      const item = this.expect('ident', 'a trait name');
      const q = this.qualify(t.text, item);
      this.qualified.push({ module: t.text, name: q.text, span: this.join(t.span, item.span) });
      return q;
    }
    return this.rn(t);
  }

  qualify(module: string, item: Token): Token {
    return this.clash.has(item.text) ? { ...item, text: `${this.modName(module + '.lum')}$${item.text}` } : item;
  }

  get cur() { return this.toks[this.pos]; }
  peek(n = 1) { return this.toks[Math.min(this.pos + n, this.toks.length - 1)]; }
  at(kind: string) { return this.cur.kind === kind; }

  next(): Token {
    const t = this.cur;
    if (t.kind !== 'eof') this.pos++;
    return t;
  }

  eat(kind: string): Token | null {
    return this.at(kind) ? this.next() : null;
  }

  fail(msg: string, span: Span = this.cur.span, hint?: string): never {
    this.diags.push({ severity: 'error', code: 'P001', message: msg, span, hint });
    throw new Bail();
  }

  expect(kind: string, what = `'${kind}'`): Token {
    if (this.at(kind)) return this.next();
    const found = this.cur.kind === 'eof' ? 'end of file' : `'${this.cur.text}'`;
    // missing ';' / ')' reads better pointing at the end of the previous token than at the next line
    const prev = this.toks[this.pos - 1];
    const span = (kind === ';' || kind === ')') && prev ? { start: prev.span.end, end: prev.span.end + 1 } : this.cur.span;
    this.fail(`expected ${what}, found ${found}`, span);
  }

  program(): Program {
    const body: Stmt[] = [];
    while (!this.at('eof')) {
      const before = this.pos;
      const s = this.statementRecovering();
      if (s) body.push(s, ...this.queue.splice(0));
      else if (this.pos === before) this.next(); // stray '}' etc, make progress
    }
    body.push(...this.hoisted);
    return { qualified: this.qualified, body, fns: this.fns, structs: this.structs, enums: this.enums, traits: this.traits, impls: this.impls, nlocals: 0, nglobals: 0 };
  }

  statementRecovering(): Stmt | null {
    try {
      return this.statement();
    } catch (e) {
      if (!(e instanceof Bail)) throw e;
      this.sync();
      return null;
    }
  }

  sync() {
    const starts = new Set(['fn', 'impl', 'trait', 'pub', 'struct', 'enum', 'match', 'for', 'let', 'var', 'if', 'while', 'return', 'break', 'continue']);
    while (!this.at('eof')) {
      if (this.at(';')) { this.next(); return; }
      if (this.at('}')) return;
      if (starts.has(this.cur.kind)) return;
      this.next();
    }
  }

  block(): Stmt[] {
    this.expect('{');
    this.depth++;
    const out: Stmt[] = [];
    let dest = out;
    while (!this.at('}') && !this.at('eof')) {
      const s = this.statementRecovering();
      if (s) dest.push(s, ...this.queue.splice(0));
      if (this.tryRest) {
        dest = this.tryRest;
        this.tryRest = null;
      }
    }
    this.depth--;
    this.expect('}');
    return out;
  }

  type(): Type {
    let out: Elem;
    if (this.cur.kind === 'ident' && this.cur.text === 'dyn' && this.peek().kind === 'ident') {
      // `dyn Shape` is an enum the analyzer builds from the impls of the trait
      this.next();
      out = enumType(`${this.traitRef().text}__dyn`);
    } else if (this.eat('(')) {
      // parentheses tell `(fn(int): int)[]` apart from `fn(int): int[]`; a comma makes it a tuple type
      out = this.type() as Elem;
      if (this.at(',')) {
        const parts: Type[] = [out];
        while (this.eat(',') && !this.at(')')) parts.push(this.type());
        out = structType(`${this.ensureTuple(parts.length)}<${parts.join(',')}>`) as Elem;
      }
      this.expect(')');
    } else if (this.eat('fn')) {
      this.expect('(');
      const ps: Type[] = [];
      if (!this.at(')')) {
        do ps.push(this.type()); while (this.eat(',') && !this.at(')'));
      }
      this.expect(')');
      out = fnType(ps, this.eat(':') ? this.type() : 'void');
    } else {
      let t = this.expect('ident', 'a type name');
      if (this.modules.has(t.text) && this.at('.')) {
        this.next();
        const item = this.expect('ident', 'a type name');
        const q = this.qualify(t.text, item);
        this.qualified.push({ module: t.text, name: q.text, span: this.join(t.span, item.span) });
        t = q;
      } else {
        t = this.rn(t);
      }
      // anything that is not a builtin type is assumed to be a struct, the analyzer checks it exists
      out = (typeFromName(t.text) ?? (this.enumNames.has(t.text) ? enumType(t.text) : structType(t.text))) as Elem;
      if (this.at('<')) {
        // Name<A, B>: stays a string until the analyzer instantiates the struct
        this.next();
        const args: Type[] = [];
        do args.push(this.type()); while (this.eat(','));
        this.expect('>');
        out = (this.enumNames.has(t.text) ? enumType : structType)(`${t.text}<${args.join(',')}>`);
      }
    }
    while (this.eat('[')) {
      this.expect(']');
      out = arrayOf(out);
    }
    return out;
  }

  // a jump to an outer loop sets a flag and leaves the inner loops one by one; each loop it crossed
  // gets a check right after it, the target loop declares the flags
  loopStmt(label: string | undefined): Stmt {
    const me: LoopInfo = { label, id: this.forId++, brk: false, cnt: false, crossing: new Set() };
    this.loops.push(me);
    const s = this.statement(true);
    this.loops.pop();
    const parent = this.loops[this.loops.length - 1];
    const sp = s.span;
    const flag = (n: string): Expr => ({ k: 'var', name: n, span: sp, ty: 'error' });
    for (const target of me.crossing) {
      const b = `_$lb${target.id}`;
      const c = `_$lc${target.id}`;
      if (target === parent) {
        if (target.brk) this.queue.push({ k: 'if', span: sp, cond: flag(b), then: [{ k: 'break', span: sp }], els: null });
        if (target.cnt) {
          this.queue.push({
            k: 'if', span: sp, cond: flag(c), els: null,
            then: [{ k: 'assign', span: sp, name: c, nameSpan: sp, value: { k: 'bool', value: false, span: sp, ty: 'error' } }, { k: 'continue', span: sp }],
          });
        }
      } else {
        const any = [target.brk ? flag(b) : null, target.cnt ? flag(c) : null].filter((x): x is Expr => x !== null);
        const cond = any.length > 1 ? ({ k: 'binary', op: '||', l: any[0], r: any[1], span: sp, ty: 'error' } as Expr) : any[0];
        this.queue.push({ k: 'if', span: sp, cond, then: [{ k: 'break', span: sp }], els: null });
      }
    }
    if (!me.brk && !me.cnt) return s;
    const off: Expr = { k: 'bool', value: false, span: sp, ty: 'error' };
    const decls: Stmt[] = [];
    if (me.brk) decls.push({ k: 'let', span: sp, name: `_$lb${me.id}`, nameSpan: sp, mutable: true, init: off });
    if (me.cnt) decls.push({ k: 'let', span: sp, name: `_$lc${me.id}`, nameSpan: sp, mutable: true, init: structuredClone(off) });
    return { k: 'block', span: sp, body: [...decls, s] };
  }

  // the return type of the function being parsed, `try` needs to know it
  retTy: Type = 'void';
  // set by `let x = try e;`: the rest of the block moves into this array, see tryLet
  tryRest: Stmt[] | null = null;

  // `outer: for ...` loops that a labelled break/continue targets, see loopStmt
  loops: LoopInfo[] = [];

  loopStart(k: number): boolean {
    const t = this.toks[this.pos + k];
    return !!t && (t.kind === 'for' || t.kind === 'while' || (t.kind === 'ident' && t.text === 'loop' && this.toks[this.pos + k + 1]?.kind === '{'));
  }

  statement(raw = false): Stmt {
    const t = this.cur;
    if (!raw) {
      if (t.kind === 'ident' && this.peek().kind === ':' && this.loopStart(2)) {
        this.next();
        this.next();
        return this.loopStmt(t.text);
      }
      if (this.loopStart(0)) return this.loopStmt(undefined);
    }
    if (t.kind === 'ident' && t.text === 'import' && this.toks[this.pos + 1]?.kind === 'string') {
      // already resolved by the module bundler
      this.next();
      this.next();
      this.eat(';');
      return { k: 'block', span: t.span, body: [] };
    }
    switch (t.kind) {
      case 'fn': {
        if (this.depth > 0 && this.toks[this.pos + 1]?.kind === 'ident') {
          // a named fn inside a body is a let bound to a lambda. one that calls itself becomes a real
          // top-level function instead (so it cannot capture locals), the let just names it
          const kw = this.next();
          const name = this.vn(this.next());
          const rec = { name: name.text, mangled: `${name.text}$r${this.lambdas++}`, used: false };
          this.recs.push(rec);
          let init = this.lambdaExpr(kw);
          this.recs.pop();
          if (rec.used && init.k === 'lambda') {
            init.fn.name = rec.mangled;
            this.hoisted.push(init.fn);
            init = { k: 'var', name: rec.mangled, span: init.span, ty: 'error' };
          }
          return { k: 'let', span: this.join(kw.span, init.span), name: name.text, nameSpan: name.span, mutable: false, init };
        }
        return this.fnDecl();
      }
      case 'pub': {
        this.next();
        const isTrait = this.cur.kind === 'trait';
        const d = this.statement();
        if (isTrait) {
          this.traits[this.traits.length - 1].pub = true;
          return d;
        }
        if (d.k === 'fn' || d.k === 'struct' || d.k === 'enum') d.pub = true;
        else this.diags.push({ severity: 'error', code: 'P005', message: "'pub' applies to fn, struct and enum declarations", span: t.span });
        return d;
      }
      case 'impl': return this.implDecl();
      case 'trait': return this.traitDecl();
      case 'struct': return this.structDecl();
      case 'enum': return this.enumDecl();
      case 'match': return this.matchStmt();
      case 'for': return this.forStmt();
      case 'let':
      case 'var': return this.letStmt();
      case 'if': return this.ifStmt();
      case 'while': {
        this.next();
        if (this.eat('let')) {
          // while let P = e { body }  is  while true { match e { P => { body } _ => { break; } } }
          const pat = this.pattern();
          this.expect('=');
          const scrut = this.condExpr();
          const body = this.block();
          const sp = this.join(t.span, this.prevSpan());
          const stop: Stmt = { k: 'break', span: t.span };
          const m: Stmt = {
            k: 'match', span: sp, scrut, tmp: -1,
            arms: [{ pats: [pat], body, span: sp }, { pats: [{ k: 'wild', span: t.span }], body: [stop], span: sp }],
          };
          return { k: 'while', span: sp, cond: { k: 'bool', value: true, span: t.span, ty: 'error' }, body: [m] };
        }
        const cond = this.condExpr();
        const body = this.block();
        return { k: 'while', span: this.join(t.span, this.prevSpan()), cond, body };
      }
      case 'return': {
        this.next();
        const value = this.at(';') ? undefined : this.expr();
        this.expect(';');
        return { k: 'return', span: this.join(t.span, this.prevSpan()), value };
      }
      case 'break':
      case 'continue': {
        this.next();
        if (this.cur.kind === 'ident') {
          const lab = this.next();
          this.expect(';');
          const at = this.loops.map(l => l.label).lastIndexOf(lab.text);
          if (at < 0) {
            this.diags.push({ severity: 'error', code: 'P001', message: `no enclosing loop is labelled '${lab.text}'`, span: lab.span });
            return { k: t.kind, span: t.span };
          }
          const target = this.loops[at];
          if (at === this.loops.length - 1) return { k: t.kind, span: t.span };
          for (const inner of this.loops.slice(at + 1)) inner.crossing.add(target);
          const name = t.kind === 'break' ? `_$lb${target.id}` : `_$lc${target.id}`;
          if (t.kind === 'break') target.brk = true;
          else target.cnt = true;
          const set: Stmt = { k: 'assign', span: t.span, name, nameSpan: t.span, value: { k: 'bool', value: true, span: t.span, ty: 'error' } };
          return { k: 'block', span: this.join(t.span, lab.span), body: [set, { k: 'break', span: t.span }] };
        }
        this.expect(';');
        return { k: t.kind, span: t.span };
      }
      case '{': {
        const body = this.block();
        return { k: 'block', span: this.join(t.span, this.prevSpan()), body };
      }
    }

    // `loop { ... }` is `while true { ... }`; loop is not reserved, `loop = 1;` is still an assignment
    if (t.kind === 'ident' && t.text === 'loop' && this.peek().kind === '{') {
      this.next();
      const body = this.block();
      return { k: 'while', span: this.join(t.span, this.prevSpan()), cond: { k: 'bool', value: true, span: t.span, ty: 'error' }, body };
    }

    if (t.kind === 'ident') {
      const nx = this.peek().kind;
      if (nx === '=' || nx in COMPOUND) {
        this.next();
        this.next();
        const rhs = this.expr();
        this.expect(';');
        // x += e  ==>  x = x + e
        const vt = this.vn(t);
        const value: Expr = nx === '='
          ? rhs
          : { k: 'binary', op: COMPOUND[nx], l: { k: 'var', name: vt.text, span: t.span, ty: 'error' }, r: rhs, span: this.join(t.span, rhs.span), ty: 'error' };
        return { k: 'assign', span: this.join(t.span, this.prevSpan()), name: vt.text, nameSpan: t.span, value };
      }
    }

    const e = this.expr();
    if (this.at(',') && (e.k === 'var' || e.k === 'field' || e.k === 'index')) return this.multiAssign(e);
    if (e.k === 'field' && (this.at('=') || this.cur.kind in COMPOUND)) {
      const opTok = this.next();
      const rhs = this.expr();
      this.expect(';');
      let value = rhs;
      if (opTok.kind !== '=') {
        if (hasCall(e)) this.fail('compound assignment needs a target without function calls', e.span, 'write it out: p.x = p.x + ...');
        value = { k: 'binary', op: COMPOUND[opTok.kind], l: e, r: rhs, span: this.join(e.span, rhs.span), ty: 'error' };
      }
      return { k: 'setfield', span: this.join(e.span, this.prevSpan()), obj: e.obj, name: e.name, nameSpan: e.nameSpan, idx: -1, value };
    }
    if (e.k === 'index' && (this.at('=') || this.cur.kind in COMPOUND)) {
      const opTok = this.next();
      const rhs = this.expr();
      this.expect(';');
      let value = rhs;
      if (opTok.kind !== '=') {
        // a[i] += v  ==>  a[i] = a[i] + v, which would run a call in the target twice
        if (hasCall(e)) this.fail('compound assignment needs a target without function calls', e.span, 'write it out: a[i] = a[i] + ...');
        value = { k: 'binary', op: COMPOUND[opTok.kind], l: e, r: rhs, span: this.join(e.span, rhs.span), ty: 'error' };
      }
      return { k: 'setindex', span: this.join(e.span, this.prevSpan()), arr: e.arr, idx: e.idx, value };
    }
    this.expect(';');
    return { k: 'expr', span: this.join(e.span, this.prevSpan()), e };
  }

  // a, b = b, a;  evaluates every right side first, then stores them left to right
  multiAssign(first: Expr): Stmt {
    const targets = [first];
    while (this.eat(',')) targets.push(this.expr());
    this.expect('=');
    const values = [this.expr()];
    while (this.eat(',')) values.push(this.expr());
    this.expect(';');
    const sp = this.join(first.span, this.prevSpan());
    if (values.length !== targets.length) this.fail(`${targets.length} targets but ${values.length} values`, sp);
    const id = this.forId++;
    const body: Stmt[] = values.map((v, i) => ({ k: 'let', span: v.span, name: `_$m${id}_${i}`, nameSpan: v.span, mutable: false, init: v }));
    targets.forEach((t, i) => {
      const value: Expr = { k: 'var', name: `_$m${id}_${i}`, span: t.span, ty: 'error' };
      if (t.k === 'var') body.push({ k: 'assign', span: t.span, name: t.name, nameSpan: t.span, value });
      else if (t.k === 'field') body.push({ k: 'setfield', span: t.span, obj: t.obj, name: t.name, nameSpan: t.nameSpan, idx: -1, value });
      else if (t.k === 'index') body.push({ k: 'setindex', span: t.span, arr: t.arr, idx: t.idx, value });
      else this.fail('cannot assign to this expression', t.span);
    });
    return { k: 'block', span: sp, body };
  }

  condExpr(): Expr {
    const saved = this.noStruct;
    this.noStruct = true;
    try {
      return this.expr();
    } finally {
      this.noStruct = saved;
    }
  }

  // struct literals are fine again inside brackets even while a condition is being parsed
  allowStruct<T>(fn: () => T): T {
    const saved = this.noStruct;
    this.noStruct = false;
    try {
      return fn();
    } finally {
      this.noStruct = saved;
    }
  }

  enumDecl(): EnumDecl {
    const kw = this.next();
    if (this.depth > 0) {
      this.diags.push({ severity: 'error', code: 'P002', message: 'enums can only be declared at the top level', span: kw.span });
    }
    const name = this.rn(this.expect('ident', 'an enum name'));
    let typeParams: string[] | undefined;
    if (this.eat('<')) {
      typeParams = [];
      do typeParams.push(this.expect('ident', 'a type parameter name').text); while (this.eat(','));
      this.expect('>');
    }
    this.expect('{');
    const variants: EnumDecl['variants'] = [];
    while (!this.at('}') && !this.at('eof')) {
      const v = this.expect('ident', 'a variant name');
      const payload: Type[] = [];
      if (this.eat('(')) {
        do payload.push(this.type()); while (this.eat(',') && !this.at(')'));
        this.expect(')');
      }
      variants.push({ name: v.text, span: v.span, payload });
      if (!this.eat(',')) break;
    }
    this.expect('}');
    if (variants.length === 0) {
      this.diags.push({ severity: 'error', code: 'P003', message: `enum '${name.text}' needs at least one variant`, span: name.span });
    }
    const decl: EnumDecl = { k: 'enum', span: this.join(kw.span, name.span), name: name.text, nameSpan: name.span, variants, typeParams };
    this.enums.push(decl);
    return decl;
  }

  // `for` is sugar over `while`. the counter is bumped *before* the body runs so
  // `continue` can't skip it, and the hidden names start with '_$' (not typable, never linted)
  forStmt(): Stmt {
    const kw = this.next();
    // `for (a, b) in pairs` takes a tuple element apart
    const parts: Token[] = [];
    const tupleName = (): Token => {
      const open = this.next();
      do parts.push(this.vn(this.expect('ident', 'a loop variable'))); while (this.eat(',') && !this.at(')'));
      this.expect(')');
      return { ...open, kind: 'ident', text: `_$t${this.forId}` };
    };
    let name = this.at('(') ? tupleName() : this.vn(this.expect('ident', 'a loop variable'));
    // `for i, x in xs` also names the position
    const indexVar = !parts.length && this.eat(',') ? name : undefined;
    if (indexVar) name = this.at('(') ? tupleName() : this.vn(this.expect('ident', 'a loop variable'));
    this.expect('in');
    const first = this.condExpr();
    const id = this.forId++;
    const sp = kw.span;
    const v = (n: string, span = sp): Expr => ({ k: 'var', name: n, span, ty: 'error' });
    const int = (value: number): Expr => ({ k: 'int', value, span: sp, ty: 'error' });
    const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'binary', op, l, r, span: sp, ty: 'error' });
    const decl = (n: string, init: Expr, mutable: boolean, nameSpan = sp): Stmt =>
      ({ k: 'let', span: sp, name: n, nameSpan, mutable, init });
    const counter = `_$i${id}`;
    let stride = 1;

    let setup: Stmt[];
    let cond: Expr;
    let elem: Expr;
    let isRange = false;
    if (this.eat('..')) {
      isRange = true;
      if (indexVar) this.diags.push({ severity: 'error', code: 'P001', message: "a range loop has no separate index, use a single variable", span: indexVar.span });
      const end = this.condExpr();
      if (this.cur.kind === 'ident' && this.cur.text === 'step') {
        this.next();
        const n = this.cur;
        if (n.kind === 'int' && (n.value as number) > 0) stride = n.value as number;
        else this.diags.push({ severity: 'error', code: 'P001', message: "'step' takes a positive integer literal", span: n.span });
        if (n.kind === 'int') this.next();
      }
      setup = [decl(`_$e${id}`, end, false), decl(counter, first, true)];
      cond = bin('<', v(counter), v(`_$e${id}`));
      elem = v(counter);
    } else {
      const arr = `_$a${id}`;
      setup = [decl(arr, first, false), decl(counter, int(0), true)];
      cond = bin('<', v(counter), { k: 'call', name: 'len', nameSpan: sp, args: [v(arr)], span: sp, ty: 'error' });
      elem = { k: 'index', arr: v(arr), idx: v(counter), span: first.span, ty: 'error' };
    }
    // over a string the step is the width of the character just read, the analyzer fills it in
    const step: Expr = !isRange
      ? { k: 'call', name: '$step', nameSpan: sp, args: [v(`_$a${id}`), v(counter)], span: sp, ty: 'error' }
      : int(stride);
    const bump: Stmt = { k: 'assign', span: sp, name: counter, nameSpan: sp, value: bin('+', v(counter), step) };
    const body = this.block();
    const loop: Stmt = {
      k: 'while', span: this.join(kw.span, this.prevSpan()), cond,
      body: [...(indexVar ? [decl(indexVar.text, v(counter), false, indexVar.span)] : []), decl(name.text, elem, false, name.span), ...parts.map((p, i) => p.text === '_' ? null : decl(p.text, { k: 'field', obj: v(name.text), name: `_${i}`, nameSpan: p.span, idx: -1, span: p.span, ty: 'error' }, false, p.span)).filter((x): x is Stmt => x !== null), bump, ...body],
    };
    return { k: 'block', span: loop.span, body: [...setup, loop] };
  }

  // `if c { a } else { b }` as a value is a match on the condition
  ifExpr(kw: Token): Expr {
    const cond = this.condExpr();
    const yes = this.braced();
    this.expect('else', "'else' (an if expression needs both branches)");
    const no = this.at('if') ? this.ifExpr(this.next()) : this.braced();
    const sp = this.join(kw.span, no.span);
    return {
      k: 'matchx', scrut: cond, tmp: -1, span: sp, ty: 'error',
      arms: [
        { pats: [{ k: 'lit', value: true, span: cond.span, ty: 'bool' }], value: yes, span: yes.span },
        { pats: [{ k: 'wild', span: no.span }], value: no, span: no.span },
      ],
    };
  }

  braced(): Expr {
    return this.blockExpr(this.expect('{'));
  }

  // `{ stmts; value }`, the open brace is already consumed. each item is first tried as the final
  // expression (it must be followed by the closing brace), otherwise it is parsed as a statement
  blockExpr(open: Token): Expr {
    const body: Stmt[] = [];
    let value: Expr | undefined;
    this.depth++;
    const startsStmt = new Set(['let', 'var', 'while', 'for', 'return', 'break', 'continue', 'fn', 'struct', 'enum', 'impl', 'trait', 'pub']);
    while (!this.at('}') && !this.at('eof')) {
      if (!startsStmt.has(this.cur.kind)) {
        const snap = [this.pos, this.diags.length, this.fns.length, this.qualified.length, this.lambdas, this.forId, this.hoisted.length];
        try {
          const e = this.allowStruct(() => this.expr());
          if (this.at('}')) {
            value = e;
            break;
          }
        } catch (err) {
          if (!(err instanceof Bail)) throw err;
        }
        [this.pos, this.diags.length, this.fns.length, this.qualified.length, this.lambdas, this.forId, this.hoisted.length] = snap;
      }
      const s = this.statementRecovering();
      if (s) body.push(s, ...this.queue.splice(0));
    }
    this.depth--;
    const close = this.expect('}');
    const span = this.join(open.span, close.span);
    if (!value) {
      this.diags.push({ severity: 'error', code: 'P001', message: 'a block expression must end with a value', span: close.span });
      value = { k: 'int', value: 0, span: close.span, ty: 'error' };
    }
    return body.length === 0 ? value : { k: 'blockx', body, value, span, ty: 'error' };
  }

  matchStmt(): Stmt {
    const kw = this.next();
    const scrut = this.condExpr();
    this.expect('{');
    const arms: MatchArm[] = [];
    while (!this.at('}') && !this.at('eof')) {
      const first = this.cur.span;
      const pats: Pat[] = [this.pattern()];
      while (this.eat('|')) pats.push(this.pattern());
      const guard = this.eat('if') ? this.expr() : undefined;
      this.expect('=>');
      const body = this.block();
      this.eat(',');
      const { binds, ...head } = this.rangeArm(scrut, pats, guard);
      arms.push({ ...head, body: binds ? [...binds, ...body] : body, span: this.join(first, this.prevSpan()) });
    }
    const close = this.expect('}');
    return { k: 'match', span: this.join(kw.span, close.span), scrut, arms, tmp: -1 };
  }

  // `1..5` and `1..=5` are written in patterns but live on as guards, see rangeArm
  ranges = new Map<Pat, { lo: number; hi: number; inclusive: boolean }>();

  // `(0, _)` patterns also become guards: one comparison per literal element
  tuples = new Map<Pat, (Pat | { bind: string; span: Span })[]>();

  pattern(): Pat {
    const p = this.basePattern();
    if (p.k === 'lit' && p.ty === 'int' && this.at('..')) {
      this.next();
      const inclusive = this.eat('=') !== null;
      const end = this.basePattern();
      if (end.k !== 'lit' || end.ty !== 'int') this.fail('a range pattern ends with an int literal', end.span);
      const r: Pat = { k: 'wild', span: this.join(p.span, end.span) };
      this.ranges.set(r, { lo: p.value as number, hi: (end as typeof p).value as number, inclusive });
      return r;
    }
    return p;
  }

  // an arm with range patterns becomes a wildcard arm whose guard tests the scrutinee
  rangeArm(scrut: Expr, pats: Pat[], guard: Expr | undefined): { pats: Pat[]; guard?: Expr; binds?: Stmt[] } {
    if (!pats.some(p => this.ranges.has(p) || this.tuples.has(p))) return { pats, guard };
    const plain = (x: Expr): boolean => x.k === 'var' || (x.k === 'field' && plain(x.obj));
    const sp = pats[0].span;
    // a written tuple is compared element by element, so its parts must be free to evaluate more than once
    const simple = (x: Expr): boolean =>
      x.k === 'int' || x.k === 'float' || x.k === 'str' || x.k === 'bool' || x.k === 'var'
      || (x.k === 'field' && simple(x.obj)) || (x.k === 'unary' && simple(x.arg)) || (x.k === 'binary' && simple(x.l) && simple(x.r));
    const lit = scrut.k === 'structlit' && /^Tuple\d+$/.test(scrut.name) ? scrut : null;
    if (lit ? !lit.fields.every(f => simple(f.value)) : !plain(scrut)) {
      this.diags.push({ severity: 'error', code: 'P001', message: 'a range or tuple pattern needs a variable, a field or plain arithmetic as the match value', span: sp });
      return { pats, guard };
    }
    const int = (value: number): Expr => ({ k: 'int', value, span: sp, ty: 'error' });
    const cmp = (op: BinOp, v: number): Expr => ({ k: 'binary', op, l: structuredClone(scrut), r: int(v), span: sp, ty: 'error' });
    const conds: Expr[] = [];
    const binds: Stmt[] = [];
    const lcmp = (l: Expr, v: Pat & { k: 'lit' }): Expr => {
      const r: Expr = v.ty === 'string' ? { k: 'str', value: v.value as string, span: sp, ty: 'error' }
        : v.ty === 'bool' ? { k: 'bool', value: v.value as boolean, span: sp, ty: 'error' } : int(v.value as number);
      return { k: 'binary', op: '==', l: structuredClone(l), r, span: sp, ty: 'error' };
    };
    for (const p of pats) {
      const r = this.ranges.get(p);
      const tp = this.tuples.get(p);
      if (tp) {
        const parts: Expr[] = [];
        tp.forEach((q, i) => {
          if (!('bind' in q) && q.k !== 'lit') return;
          const at: Expr = lit ? structuredClone(lit.fields[i]?.value ?? int(0)) : { k: 'field', obj: structuredClone(scrut), name: `_${i}`, nameSpan: sp, idx: -1, span: sp, ty: 'error' };
          if ('bind' in q) {
            if (pats.length > 1) this.diags.push({ severity: 'error', code: 'P001', message: 'names in a tuple pattern cannot be combined with |', span: q.span });
            binds.push({ k: 'let', span: q.span, name: q.bind, nameSpan: q.span, mutable: false, init: at });
          } else parts.push(lcmp(at, q));
        });
        if (lit && tp.length !== lit.fields.length) this.diags.push({ severity: 'error', code: 'P001', message: `this pattern has ${tp.length} parts, the value has ${lit.fields.length}`, span: p.span });
        conds.push(parts.length ? parts.reduce((a, b) => ({ k: 'binary', op: '&&', l: a, r: b, span: sp, ty: 'error' }) as Expr) : { k: 'bool', value: true, span: sp, ty: 'error' });
      } else if (r) conds.push({ k: 'binary', op: '&&', l: cmp('>=', r.lo), r: cmp(r.inclusive ? '<=' : '<', r.hi), span: sp, ty: 'error' });
      else if (p.k === 'lit' && p.ty === 'int' && !lit) conds.push(cmp('==', p.value as number));
      else {
        this.diags.push({ severity: 'error', code: 'P001', message: 'range and tuple patterns can only be mixed with int literals', span: p.span });
        return { pats, guard };
      }
    }
    let all = conds.reduce((a, b) => ({ k: 'binary', op: '||', l: a, r: b, span: sp, ty: 'error' }) as Expr);
    // (a, b) with only names and _ always matches, so it stays a plain wildcard arm
    if (conds.some(c => c.k === 'bool')) {
      return { pats: [{ k: 'wild', span: sp }], guard, binds: binds.length ? binds : undefined };
    }
    if (guard) all = { k: 'binary', op: '&&', l: all, r: guard, span: sp, ty: 'error' };
    if (binds.length && guard) this.diags.push({ severity: 'error', code: 'P001', message: 'a guard cannot use names bound by a tuple pattern, test them with an if in the arm', span: guard.span });
    return { pats: [{ k: 'wild', span: sp }], guard: all, binds: binds.length ? binds : undefined };
  }

  basePattern(): Pat {
    const t = this.next();
    switch (t.kind) {
      case 'ident': {
        if (t.text === '_') return { k: 'wild', span: t.span };
        let binds: Extract<Pat, { k: 'variant' }>['binds'] = null;
        let end = t.span;
        if (this.eat('(')) {
          binds = [];
          if (!this.at(')')) {
            do {
              const b = this.vn(this.expect('ident', 'a binding name'));
              binds.push(b.text === '_' ? null : { name: b.text, span: b.span });
            } while (this.eat(',') && !this.at(')'));
          }
          end = this.expect(')').span;
        }
        return { k: 'variant', span: this.join(t.span, end), name: t.text, idx: -1, binds, tys: [], boxed: false };
      }
      case '(': {
        const parts: (Pat | { bind: string; span: Span })[] = [];
        do {
          if (this.cur.kind === 'ident' && this.cur.text !== '_' && this.peek().kind !== '(') {
            const b = this.vn(this.next());
            parts.push({ bind: b.text, span: b.span });
            continue;
          }
          const q = this.basePattern();
          if (q.k === 'variant') this.fail('tuple patterns hold literals, names and _', q.span);
          parts.push(q);
        } while (this.eat(',') && !this.at(')'));
        const close = this.expect(')');
        const w: Pat = { k: 'wild', span: this.join(t.span, close.span) };
        this.tuples.set(w, parts);
        return w;
      }
      case 'int': return { k: 'lit', span: t.span, value: t.value as number, ty: 'int' };
      case 'string': return { k: 'lit', span: t.span, value: t.value as string, ty: 'string' };
      case 'true':
      case 'false': return { k: 'lit', span: t.span, value: t.kind === 'true', ty: 'bool' };
      case '-': {
        const n = this.expect('int', 'an integer');
        return { k: 'lit', span: this.join(t.span, n.span), value: -(n.value as number), ty: 'int' };
      }
    }
    if (t.kind !== 'eof') this.pos--;
    this.fail(`expected a pattern, found '${t.text}'`, t.span, 'patterns are: Variant, _, an int, string or bool literal');
  }

  // tuples are generic structs Tuple2<A, B> { _0: A, _1: B }, declared the first time one is written
  ensureTuple(n: number): string {
    const name = `Tuple${n}`;
    if (this.structs.some(s => s.name === name)) return name;
    const params = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
    const span = this.prevSpan();
    this.structs.push({
      k: 'struct', span, name, nameSpan: span, typeParams: params, pub: true,
      fields: params.map((p, i) => ({ name: `_${i}`, ty: structType(p), span })),
    });
    return name;
  }

  structDecl(): StructDecl {
    const kw = this.next();
    if (this.depth > 0) {
      this.diags.push({ severity: 'error', code: 'P002', message: 'structs can only be declared at the top level', span: kw.span });
    }
    const name = this.rn(this.expect('ident', 'a struct name'));
    let typeParams: string[] | undefined;
    if (this.eat('<')) {
      typeParams = [];
      do typeParams.push(this.expect('ident', 'a type parameter name').text); while (this.eat(','));
      this.expect('>');
    }
    this.expect('{');
    const fields: StructField[] = [];
    while (!this.at('}') && !this.at('eof')) {
      const f = this.expect('ident', 'a field name');
      this.expect(':');
      fields.push({ name: f.text, span: f.span, ty: this.type() });
      if (!this.eat(',')) break;
    }
    this.expect('}');
    if (fields.length === 0) {
      this.diags.push({ severity: 'error', code: 'P003', message: `struct '${name.text}' needs at least one field`, span: name.span });
    }
    const decl: StructDecl = { k: 'struct', span: this.join(kw.span, name.span), name: name.text, nameSpan: name.span, fields, typeParams, shown: name.text.includes('$') ? name.text.split('$').pop() : undefined };
    this.structs.push(decl);
    return decl;
  }

  traitDecl(): Stmt {
    const kw = this.next();
    if (this.depth > 0) {
      this.diags.push({ severity: 'error', code: 'P002', message: 'traits can only be declared at the top level', span: kw.span });
    }
    const name = this.rn(this.expect('ident', 'a trait name'));
    this.expect('{');
    const methods: TraitDecl['methods'] = [];
    while (!this.at('}') && !this.at('eof')) {
      const f = this.expect('fn', `'fn'`);
      const m = this.expect('ident', 'a method name');
      this.expect('(');
      let hasSelf = false;
      const params: Param[] = [];
      if (!this.at(')')) {
        do {
          const p = this.vn(this.expect('ident', 'a parameter name'));
          if (params.length === 0 && !hasSelf && p.text === 'self' && !this.at(':')) {
            hasSelf = true;
            continue;
          }
          this.expect(':');
          params.push({ name: p.text, span: p.span, ty: this.type() });
        } while (this.eat(',') && !this.at(')'));
      }
      this.expect(')');
      const ret: Type = this.eat(':') ? this.type() : 'void';
      // a body makes it a default method, impls that do not define it get a copy
      const body = this.at('{') ? this.block() : undefined;
      if (!body) this.expect(';');
      methods.push({ name: m.text, span: this.join(f.span, m.span), hasSelf, params, ret, body });
    }
    const close = this.expect('}');
    this.traits.push({ name: name.text, nameSpan: name.span, methods });
    return { k: 'block', span: this.join(kw.span, close.span), body: [] };
  }

  // `impl T { fn m(self) ... }` is sugar for top-level functions named `T$m`;
  // `x.m(a)` is resolved to `T$m(x, a)` by the analyzer
  implDecl(): Stmt {
    const kw = this.next();
    if (this.depth > 0) {
      this.diags.push({ severity: 'error', code: 'P002', message: 'impl blocks can only be declared at the top level', span: kw.span });
    }
    // impl<T> Box<T> { ... }: every method becomes a generic function over the impl's type parameters
    let implParams: string[] | undefined;
    let implBounds: Record<string, string[]> | undefined;
    if (this.eat('<')) {
      implParams = [];
      do {
        const tp = this.expect('ident', 'a type parameter name').text;
        implParams.push(tp);
        if (this.eat(':')) {
          implBounds ??= {};
          implBounds[tp] = [];
          do implBounds[tp].push(this.traitRef().text); while (this.eat('+'));
        }
      } while (this.eat(','));
      this.expect('>');
    }
    let name = this.expect('ident', 'a type name');
    let trait: Token | undefined;
    if (this.eat('for')) {
      // impl Trait for Type: the methods are ordinary `Type$m` functions, the analyzer checks them against the trait
      trait = this.rn(name);
      name = this.expect('ident', 'a type name');
    }
    name = this.rn(name);
    let owner = name.text;
    let ownerTy: Type | undefined;
    if (this.eat('<')) {
      const args: Type[] = [];
      do args.push(this.type()); while (this.eat(','));
      this.expect('>');
      // methods of impl<T> Box<T> keep the bare name, they are templates; a concrete instance names itself
      owner = implParams ? name.text : `${name.text}<${args.join(',')}>`;
      ownerTy = (this.enumNames.has(name.text) ? enumType : structType)(`${name.text}<${args.join(',')}>`);
    }
    if (trait) this.impls.push({ trait: trait.text, type: owner, span: this.join(kw.span, name.span) });
    this.expect('{');
    const body: Stmt[] = [];
    while (!this.at('}') && !this.at('eof')) {
      if (!this.at('fn')) this.fail(`expected 'fn' inside impl, found '${this.cur.text}'`);
      body.push(this.fnDecl(owner, ownerTy, implParams, implBounds));
    }
    const close = this.expect('}');
    return { k: 'block', span: this.join(kw.span, close.span), body };
  }

  // the body becomes an ordinary function under a made-up name, the analyzer adds the captured locals as extra params
  lambdaExpr(t: Token): Expr {
    const outer = this.loops;
    this.loops = [];
    try {
      return this.lambdaInner(t);
    } finally {
      this.loops = outer;
    }
  }

  lambdaInner(t: Token): Expr {
    const outerRet = this.retTy;
    this.retTy = 'void';
    try {
      return this.lambdaBody(t);
    } finally {
      this.retTy = outerRet;
    }
  }

  lambdaBody(t: Token): Expr {
        this.expect('(');
        const params: Param[] = [];
        if (!this.at(')')) {
          do {
            const p = this.vn(this.expect('ident', 'a parameter name'));
            // no annotation: the analyzer fills it in from the expected function type
            params.push({ name: p.text, span: p.span, ty: this.eat(':') ? this.type() : ('?' as Type) });
          } while (this.eat(',') && !this.at(')'));
        }
        this.expect(')');
        let ret: Type = this.eat(':') ? this.type() : 'void';
        let body: Stmt[];
        if (this.eat('=>')) {
          if (ret === 'void') ret = '?' as Type;
          const value = this.allowStruct(() => this.expr());
          body = [{ k: 'return', span: value.span, value }];
        } else {
          body = this.allowStruct(() => this.block());
          // untyped params and no annotation: the block's return decides, like an => body
          if (ret === 'void' && params.some(p => p.ty === '?') && body.some(st => st.k === 'return' && st.value)) ret = '?' as Type;
        }
        const name = `lambda$${this.lambdas++}`;
        const fn: FnDecl = { k: 'fn', span: this.join(t.span, this.prevSpan()), name, nameSpan: t.span, params, ret, body, nlocals: 0 };
        this.fns.push(fn);
        return { k: 'lambda', fn, caps: [], span: fn.span, ty: 'error' };
  }

  fnDecl(owner?: string, ownerTy?: Type, implParams?: string[], implBounds?: Record<string, string[]>): FnDecl {
    const outer = this.loops;
    this.loops = [];
    try {
      return this.fnInner(owner, ownerTy, implParams, implBounds);
    } finally {
      this.loops = outer;
    }
  }

  fnInner(owner?: string, ownerTy?: Type, implParams?: string[], implBounds?: Record<string, string[]>): FnDecl {
    const kw = this.next();
    if (this.depth > 0) {
      this.diags.push({ severity: 'error', code: 'P002', message: 'functions can only be declared at the top level', span: kw.span });
    }
    const name = owner ? this.expect('ident', 'a function name') : this.rn(this.expect('ident', 'a function name'));
    let typeParams: string[] | undefined;
    let bounds: Record<string, string[]> | undefined;
    if (!owner && this.eat('<')) {
      typeParams = [];
      do {
        const tp = this.expect('ident', 'a type parameter name').text;
        typeParams.push(tp);
        if (this.eat(':')) {
          bounds ??= {};
          bounds[tp] = [];
          do bounds[tp].push(this.traitRef().text); while (this.eat('+'));
        }
      } while (this.eat(','));
      this.expect('>');
    }
    this.expect('(');
    const params: Param[] = [];
    if (!this.at(')')) {
      do {
        const p = this.vn(this.expect('ident', 'a parameter name'));
        if (owner && p.text === 'self' && params.length === 0 && !this.at(':')) {
          const ty = (ownerTy ?? typeFromName(owner) ?? (this.enumNames.has(owner) ? enumType(owner) : structType(owner))) as Elem;
          params.push({ name: 'self', span: p.span, ty });
          continue;
        }
        this.expect(':');
        const ty = this.type();
        const def = this.eat('=') ? this.expr() : undefined;
        if (!def && params.some(q => q.def)) this.diags.push({ severity: 'error', code: 'P001', message: `parameter '${p.text}' needs a default value because an earlier parameter has one`, span: p.span });
        params.push({ name: p.text, span: p.span, ty, def });
      } while (this.eat(',') && !this.at(')'));
    }
    this.expect(')');
    const ret: Type = this.eat(':') ? this.type() : 'void';
    const outerRet = this.retTy;
    this.retTy = ret;
    const body = this.block();
    this.retTy = outerRet;
    const decl: FnDecl = { k: 'fn', span: this.join(kw.span, name.span), name: name.text, nameSpan: name.span, params, ret, body, nlocals: 0, typeParams: typeParams ?? implParams, bounds: bounds ?? implBounds };
    if (owner) decl.name = `${owner}$${name.text}`;
    this.fns.push(decl);
    return decl;
  }

  letStmt(): Stmt {
    const kw = this.next();
    if (this.at('[') || this.at('(') || (this.cur.kind === 'ident' && this.peek().kind === '{')) return this.destructure(kw);
    const name = this.vn(this.expect('ident', 'a variable name'));
    let annot: Type | undefined;
    let annotSpan: Span | undefined;
    if (this.eat(':')) {
      annotSpan = this.cur.span;
      annot = this.type();
    }
    this.expect('=');
    if (this.cur.kind === 'ident' && this.cur.text === 'try' && ![';', '=', '.', ',', ')'].includes(this.peek().kind)) {
      return this.tryLet(kw, name, annot, annotSpan);
    }
    const init = this.expr();
    this.expect(';');
    return {
      k: 'let', span: this.join(kw.span, this.prevSpan()), name: name.text, nameSpan: name.span,
      mutable: kw.kind === 'var', annot, annotSpan, init,
    };
  }

  // let v = try e;  continues with v only when e is Ok (or Some); otherwise the function returns the Err (or None):
  //   match e { Err(m) => { return Result.Err(m); } Ok(t) => { let v = t; ...rest of the block... } }
  tryLet(kw: Token, name: Token, annot: Type | undefined, annotSpan: Span | undefined): Stmt {
    this.next();
    const e = this.expr();
    this.expect(';');
    const sp = this.join(kw.span, this.prevSpan());
    const base = this.retTy.replace(/^[#@]/, '').split('<')[0];
    if (base !== 'Result' && base !== 'Option') {
      this.diags.push({ severity: 'error', code: 'P001', message: 'try needs the function to return a Result or an Option', span: sp });
      return { k: 'let', span: sp, name: name.text, nameSpan: name.span, mutable: kw.kind === 'var', annot, annotSpan, init: e };
    }
    const id = this.forId++;
    const tmp = `_$t${id}`;
    const msg = `_$m${id}`;
    const v = (n: string): Expr => ({ k: 'var', name: n, span: sp, ty: 'error' });
    const variant = (vn: string, bind?: string): Pat => ({ k: 'variant', span: sp, name: vn, idx: -1, binds: bind ? [{ name: bind, span: sp }] : null, tys: [], boxed: false });
    const rest: Stmt[] = [{ k: 'let', span: sp, name: name.text, nameSpan: name.span, mutable: kw.kind === 'var', annot, annotSpan, init: v(tmp) }];
    const bail: Expr = base === 'Result'
      ? { k: 'mcall', obj: v('Result'), name: 'Err', nameSpan: sp, args: [v(msg)], span: sp, ty: 'error' }
      : { k: 'field', obj: v('Option'), name: 'None', nameSpan: sp, idx: -1, span: sp, ty: 'error' };
    this.tryRest = rest;
    return {
      k: 'match', span: sp, scrut: e, tmp: -1,
      arms: [
        { pats: [base === 'Result' ? variant('Err', msg) : variant('None')], body: [{ k: 'return', span: sp, value: bail }], span: sp },
        { pats: [base === 'Result' ? variant('Ok', tmp) : variant('Some', tmp)], body: rest, span: sp },
      ],
    };
  }

  // let [a, b] = e;  and  let P { x, y: z } = e;  bind a hidden copy first, then one let per name
  destructure(kw: Token): Stmt {
    const id = this.forId++;
    const tmp = `_$d${id}`;
    const picks: { name: Token; at: (obj: Expr) => Expr }[] = [];
    const mk = (obj: Expr, e: Omit<Extract<Expr, { k: 'index' }>, 'k' | 'arr' | 'span' | 'ty'>): Expr => ({ k: 'index', arr: obj, ...e, span: obj.span, ty: 'error' });
    if (this.eat('(')) {
      // let (a, b) = e;  reads _0, _1, ... and nested tuples compose the accessors
      const tuple = (outer: (obj: Expr) => Expr) => {
        let i = 0;
        do {
          const at = i++;
          const get = (obj: Expr): Expr => ({ k: 'field', obj: outer(obj), name: `_${at}`, nameSpan: this.cur.span, idx: -1, span: this.cur.span, ty: 'error' });
          if (this.eat('(')) {
            tuple(get);
            continue;
          }
          const n = this.vn(this.expect('ident', 'a variable name'));
          if (n.text !== '_') picks.push({ name: n, at: get });
        } while (this.eat(',') && !this.at(')'));
        this.expect(')');
      };
      tuple(o => o);
    } else if (this.eat('[')) {
      let i = 0;
      do {
        const n = this.vn(this.expect('ident', 'a variable name'));
        const at = i++;
        if (n.text !== '_') picks.push({ name: n, at: obj => mk(obj, { idx: { k: 'int', value: at, span: n.span, ty: 'error' } }) });
      } while (this.eat(',') && !this.at(']'));
      this.expect(']');
    } else {
      this.next();
      this.expect('{');
      do {
        const f = this.expect('ident', 'a field name');
        const n = this.eat(':') ? this.vn(this.expect('ident', 'a variable name')) : this.vn(f);
        picks.push({ name: n, at: obj => ({ k: 'field', obj, name: f.text, nameSpan: f.span, idx: -1, span: f.span, ty: 'error' }) });
      } while (this.eat(',') && !this.at('}'));
      this.expect('}');
    }
    this.expect('=');
    const init = this.expr();
    this.expect(';');
    const sp = this.join(kw.span, this.prevSpan());
    const ref: Expr = { k: 'var', name: tmp, span: sp, ty: 'error' };
    for (const p of picks) {
      this.queue.push({ k: 'let', span: sp, name: p.name.text, nameSpan: p.name.span, mutable: kw.kind === 'var', init: p.at({ ...ref }) });
    }
    return { k: 'let', span: sp, name: tmp, nameSpan: sp, mutable: false, init };
  }

  ifStmt(): Stmt {
    const kw = this.next();
    if (this.eat('let')) {
      // if let Some(x) = e { a } else { b }  is  match e { Some(x) => { a } _ => { b } }
      const pat = this.pattern();
      this.expect('=');
      const scrut = this.condExpr();
      const then = this.block();
      let els: Stmt[] = [];
      if (this.eat('else')) els = this.at('if') ? [this.ifStmt()] : this.block();
      const sp = this.join(kw.span, this.prevSpan());
      return {
        k: 'match', span: sp, scrut, tmp: -1,
        arms: [{ pats: [pat], body: then, span: sp }, { pats: [{ k: 'wild', span: kw.span }], body: els, span: sp }],
      };
    }
    const cond = this.condExpr();
    const then = this.block();
    let els: Stmt[] | null = null;
    if (this.eat('else')) {
      els = this.at('if') ? [this.ifStmt()] : this.block();
    }
    return { k: 'if', span: this.join(kw.span, this.prevSpan()), cond, then, els };
  }

  prevSpan(): Span {
    return this.toks[Math.max(0, this.pos - 1)].span;
  }

  join(a: Span, b: Span): Span {
    return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
  }

  expr(minPrec = 1): Expr {
    let l = this.unary();
    for (;;) {
      const op = this.cur.kind;
      const p = PREC[op];
      if (p === undefined || p < minPrec) return l;
      this.next();
      const r = this.expr(p + 1);
      l = { k: 'binary', op: op as BinOp, l, r, span: this.join(l.span, r.span), ty: 'error' };
    }
  }

  unary(): Expr {
    const t = this.cur;
    if (t.kind === '-' || t.kind === '!') {
      this.next();
      const arg = this.unary();
      return { k: 'unary', op: t.kind, arg, span: this.join(t.span, arg.span), ty: 'error' };
    }
    return this.postfix();
  }

  structLit(nameTok: Token): Expr {
    this.expect('{');
    const fields: FieldInit[] = [];
    let base: Expr | undefined;
    this.allowStruct(() => {
      while (!this.at('}') && !this.at('eof')) {
        // `P { x: 1, ..other }` copies the fields that are not listed
        if (this.eat('..')) {
          base = this.postfix();
          break;
        }
        const f = this.expect('ident', 'a field name');
        // `P { x, y }` is `P { x: x, y: y }`
        const value: Expr = !this.at(':') && (this.at(',') || this.at('}'))
          ? { k: 'var', name: this.vn(f).text, span: f.span, ty: 'error' }
          : (this.expect(':'), this.expr());
        fields.push({ name: f.text, nameSpan: f.span, value, idx: -1 });
        if (!this.eat(',')) break;
      }
    });
    const close = this.expect('}');
    return { k: 'structlit', name: nameTok.text, nameSpan: nameTok.span, fields, base, span: this.join(nameTok.span, close.span), ty: 'error' };
  }

  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.at('[')) {
        this.next();
        // a[..hi] starts at 0
        const idx = this.at('..') ? { k: 'int', value: 0, span: this.cur.span, ty: 'error' } as Expr : this.allowStruct(() => this.expr());
        if (this.eat('..')) {
          // a[lo..hi] is slice(a, lo, hi - lo); lo and a are written twice, so keep them free of side effects
          const inclusive = this.eat('=') !== null;
          let hi: Expr = this.at(']')
            ? { k: 'call', name: 'len', nameSpan: idx.span, args: [structuredClone(e)], span: idx.span, ty: 'error' }
            : this.allowStruct(() => this.expr());
          if (inclusive) hi = { k: 'binary', op: '+', l: hi, r: { k: 'int', value: 1, span: hi.span, ty: 'error' }, span: hi.span, ty: 'error' };
          const end = this.expect(']');
          const count: Expr = { k: 'binary', op: '-', l: hi, r: structuredClone(idx), span: hi.span, ty: 'error' };
          e = { k: 'call', name: 'slice', nameSpan: idx.span, args: [e, idx, count], span: this.join(e.span, end.span), ty: 'error' };
          continue;
        }
        const close = this.expect(']');
        e = { k: 'index', arr: e, idx, span: this.join(e.span, close.span), ty: 'error' };
      } else if (this.at('(')) {
        this.next();
        const args: Expr[] = [];
        if (!this.at(')')) {
          do args.push(this.allowStruct(() => this.expr())); while (this.eat(',') && !this.at(')'));
        }
        const close = this.expect(')');
        e = { k: 'call', name: 'call', nameSpan: e.span, args, callee: e, span: this.join(e.span, close.span), ty: 'error' };
      } else if (this.at('.')) {
        this.next();
        // t.0 reads a tuple element; t.0.1 lexes as the float 0.1, so split it
        if (this.cur.kind === 'float' && /^\d+\.\d+$/.test(this.cur.text)) {
          const ft = this.next();
          const [a, b] = ft.text.split('.');
          const sp = ft.span;
          const first = { k: 'field', obj: e, name: `_${a}`, nameSpan: sp, idx: -1, span: this.join(e.span, sp), ty: 'error' } as Expr;
          e = { k: 'field', obj: first, name: `_${b}`, nameSpan: sp, idx: -1, span: this.join(e.span, sp), ty: 'error' };
          continue;
        }
        const f = this.cur.kind === 'int' ? (tok => ({ ...tok, text: `_${tok.text}` }))(this.next()) : this.expect('ident', 'a field name');
        if (this.at('(')) {
          this.next();
          const args: Expr[] = [];
          const argNames: (string | undefined)[] = [];
          if (!this.at(')')) {
            do {
              const named = this.cur.kind === 'ident' && this.peek().kind === ':';
              argNames.push(named ? this.next().text : undefined);
              if (named) this.next();
              args.push(this.allowStruct(() => this.expr()));
            } while (this.eat(',') && !this.at(')'));
          }
          const close = this.expect(')');
          e = { k: 'mcall', obj: e, name: f.text, nameSpan: f.span, args, argNames: argNames.some(Boolean) ? argNames : undefined, span: this.join(e.span, close.span), ty: 'error' };
        } else {
          e = { k: 'field', obj: e, name: f.text, nameSpan: f.span, idx: -1, span: this.join(e.span, f.span), ty: 'error' };
        }
      } else {
        return e;
      }
    }
  }

  primary(): Expr {
    const t = this.next();
    switch (t.kind) {
      case 'int': return { k: 'int', value: t.value as number, span: t.span, ty: 'error' };
      case 'float': return { k: 'float', value: t.value as number, span: t.span, ty: 'error' };
      case 'string': return { k: 'str', value: t.value as string, span: t.span, ty: 'error' };
      case 'true':
      case 'false': return { k: 'bool', value: t.kind === 'true', span: t.span, ty: 'error' };
      case '(': {
        const e = this.allowStruct(() => this.expr());
        if (this.at(',')) {
          // (a, b) is a Tuple2 { _0: a, _1: b }
          const items = [e];
          while (this.eat(',') && !this.at(')')) items.push(this.allowStruct(() => this.expr()));
          const close = this.expect(')');
          const name = this.ensureTuple(items.length);
          const fields = items.map((value, i) => ({ name: `_${i}`, nameSpan: value.span, value, idx: -1 }));
          return { k: 'structlit', name, nameSpan: t.span, fields, span: this.join(t.span, close.span), ty: 'error' };
        }
        this.expect(')');
        return e;
      }
      case 'if': return this.ifExpr(t);
      case '{': return this.blockExpr(t);
      case 'match': {
        const scrut = this.condExpr();
        this.expect('{');
        const arms: Extract<Expr, { k: 'matchx' }>['arms'] = [];
        while (!this.at('}') && !this.at('eof')) {
          const first = this.cur.span;
          const pats: Pat[] = [this.pattern()];
          while (this.eat('|')) pats.push(this.pattern());
          const guard = this.eat('if') ? this.allowStruct(() => this.expr()) : undefined;
          this.expect('=>');
          const braces = this.at('{');
          const value = braces ? this.blockExpr(this.next()) : this.allowStruct(() => this.expr());
          const { binds, ...head } = this.rangeArm(scrut, pats, guard);
          arms.push({ ...head, value: binds ? { k: 'blockx', body: binds, value, span: value.span, ty: 'error' } : value, span: this.join(first, value.span) });
          if (!this.eat(',') && !braces) break;
        }
        const close = this.expect('}');
        return { k: 'matchx', scrut, arms, tmp: -1, span: this.join(t.span, close.span), ty: 'error' };
      }
      case '[': {
        const elems: Expr[] = [];
        if (!this.at(']')) {
          do elems.push(this.allowStruct(() => this.expr())); while (this.eat(',') && !this.at(']'));
        }
        const close = this.expect(']');
        return { k: 'array', elems, span: this.join(t.span, close.span), ty: 'error' };
      }
      case 'fn': return this.lambdaExpr(t);
      case 'ident': {
        if (this.modules.has(t.text) && this.at('.') && this.peek().kind === 'ident') {
          // module.item: the qualifier is dropped here and checked by the analyzer
          this.next();
          const item = this.next();
          const q = this.qualify(t.text, item);
          this.qualified.push({ module: t.text, name: q.text, span: this.join(t.span, item.span) });
          return this.identExpr(q, true);
        }
        return this.identExpr(t);
      }
    }
    const found = t.kind === 'eof' ? 'end of file' : `'${t.text}'`;
    if (t.kind !== 'eof') this.pos--; // leave the bad token for sync() to skip
    this.fail(`expected an expression, found ${found}`, t.span);
  }

  identExpr(t: Token, qualified = false): Expr {
    if (!qualified && this.clash.has(t.text)) {
      const kind = this.declared.get(this.fileOf(t))?.get(t.text);
      const typePath = this.at('.') && (kind === 'enum' || kind === 'struct');
      if (this.at('(') || (this.at('{') && !this.noStruct) || typePath) t = this.rn(t);
    }
    t = this.vn(t);
    if (this.at('(')) {
      const rec = [...this.recs].reverse().find(r => r.name === t.text);
      if (rec) {
        rec.used = true;
        t = { ...t, text: rec.mangled };
      }
    }
    if (this.at('{') && !this.noStruct) return this.structLit(t);
    if (!this.at('(')) return { k: 'var', name: t.text, span: t.span, ty: 'error' };
    this.next();
    const args: Expr[] = [];
    const argNames: (string | undefined)[] = [];
    if (!this.at(')')) {
      do {
        // `f(width: 3)` names the parameter
        const named = this.cur.kind === 'ident' && this.peek().kind === ':';
        if (named) {
          argNames.push(this.next().text);
          this.next();
        } else {
          argNames.push(undefined);
        }
        args.push(this.allowStruct(() => this.expr()));
      } while (this.eat(',') && !this.at(')'));
    }
    const close = this.expect(')');
    // assert(x > 1) reports "assertion failed: x > 1"
    if (t.text === 'assert' && args.length === 1) {
      const text = this.src.slice(args[0].span.start, args[0].span.end).replace(/\s+/g, ' ');
      args.push({ k: 'str', value: text, span: args[0].span, ty: 'error' });
    }
    // print(a, b) is print(str(a) + " " + str(b))
    if (t.text === 'print' && args.length > 1 && !argNames.some(Boolean)) {
      const sp = this.join(t.span, close.span);
      const str = (a: Expr): Expr => ({ k: 'call', name: 'str', nameSpan: a.span, args: [a], span: a.span, ty: 'error' });
      const sep: Expr = { k: 'str', value: ' ', span: sp, ty: 'error' };
      const line = args.slice(1).reduce((acc: Expr, a) => ({ k: 'binary', op: '+', l: { k: 'binary', op: '+', l: acc, r: sep, span: sp, ty: 'error' }, r: str(a), span: sp, ty: 'error' }) as Expr, str(args[0]));
      return { k: 'call', name: 'print', nameSpan: t.span, args: [line], span: sp, ty: 'error' };
    }
    return { k: 'call', name: t.text, nameSpan: t.span, args, argNames: argNames.some(Boolean) ? argNames : undefined, span: this.join(t.span, close.span), ty: 'error' };
  }
}

export function parse(src: string, segments: Segment[] = []): { program: Program; diags: Diagnostic[] } {
  const { tokens, diags } = lex(src);
  const p = new Parser(tokens, diags, segments);
  p.src = src;
  const program = p.program();
  return { program, diags };
}
