import type { Diagnostic, Segment, Span } from './diagnostics.ts';
import type { BinOp, EnumDecl, Expr, FieldInit, FnDecl, ImplFor, MatchArm, Param, Pat, Program, Qualified, Stmt, StructDecl, StructField, TraitDecl } from './ast.ts';
import { lex } from './lexer.ts';
import type { Token } from './lexer.ts';
import { arrayOf, enumType, fnType, structType, typeFromName } from './types.ts';
import type { Elem, Type } from './types.ts';

class Bail extends Error {}

function hasCall(e: Expr): boolean {
  switch (e.k) {
    case 'call': return true;
    case 'unary': return hasCall(e.arg);
    case 'binary': return hasCall(e.l) || hasCall(e.r);
    case 'index': return hasCall(e.arr) || hasCall(e.idx);
    case 'array': return e.elems.some(hasCall);
    case 'field': return hasCall(e.obj);
    case 'mcall': return true;
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
      if (s) body.push(s);
      else if (this.pos === before) this.next(); // stray '}' etc, make progress
    }
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
    while (!this.at('}') && !this.at('eof')) {
      const s = this.statementRecovering();
      if (s) out.push(s);
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
      // parentheses tell `(fn(int): int)[]` apart from `fn(int): int[]`
      out = this.type() as Elem;
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

  statement(): Stmt {
    const t = this.cur;
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
          // a named fn inside a body is a let bound to a lambda: it captures like one and cannot call itself
          const kw = this.next();
          const name = this.vn(this.next());
          const init = this.lambdaExpr(kw);
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
        this.expect(';');
        return { k: t.kind, span: t.span };
      }
      case '{': {
        const body = this.block();
        return { k: 'block', span: this.join(t.span, this.prevSpan()), body };
      }
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
    const name = this.vn(this.expect('ident', 'a loop variable'));
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
    if (this.eat('..')) {
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
    const bump: Stmt = { k: 'assign', span: sp, name: counter, nameSpan: sp, value: bin('+', v(counter), int(stride)) };
    const body = this.block();
    const loop: Stmt = {
      k: 'while', span: this.join(kw.span, this.prevSpan()), cond,
      body: [decl(name.text, elem, false, name.span), bump, ...body],
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
    this.expect('{');
    const e = this.allowStruct(() => this.expr());
    this.expect('}');
    return e;
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
      arms.push({ pats, guard, body, span: this.join(first, this.prevSpan()) });
    }
    const close = this.expect('}');
    return { k: 'match', span: this.join(kw.span, close.span), scrut, arms, tmp: -1 };
  }

  pattern(): Pat {
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
        this.expect('(');
        const params: Param[] = [];
        if (!this.at(')')) {
          do {
            const p = this.vn(this.expect('ident', 'a parameter name'));
            this.expect(':');
            params.push({ name: p.text, span: p.span, ty: this.type() });
          } while (this.eat(',') && !this.at(')'));
        }
        this.expect(')');
        const ret: Type = this.eat(':') ? this.type() : 'void';
        const body = this.allowStruct(() => this.block());
        const name = `lambda$${this.lambdas++}`;
        const fn: FnDecl = { k: 'fn', span: this.join(t.span, this.prevSpan()), name, nameSpan: t.span, params, ret, body, nlocals: 0 };
        this.fns.push(fn);
        return { k: 'lambda', fn, caps: [], span: fn.span, ty: 'error' };
  }

  fnDecl(owner?: string, ownerTy?: Type, implParams?: string[], implBounds?: Record<string, string[]>): FnDecl {
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
        params.push({ name: p.text, span: p.span, ty: this.type() });
      } while (this.eat(',') && !this.at(')'));
    }
    this.expect(')');
    const ret: Type = this.eat(':') ? this.type() : 'void';
    const body = this.block();
    const decl: FnDecl = { k: 'fn', span: this.join(kw.span, name.span), name: name.text, nameSpan: name.span, params, ret, body, nlocals: 0, typeParams: typeParams ?? implParams, bounds: bounds ?? implBounds };
    if (owner) decl.name = `${owner}$${name.text}`;
    this.fns.push(decl);
    return decl;
  }

  letStmt(): Stmt {
    const kw = this.next();
    const name = this.vn(this.expect('ident', 'a variable name'));
    let annot: Type | undefined;
    let annotSpan: Span | undefined;
    if (this.eat(':')) {
      annotSpan = this.cur.span;
      annot = this.type();
    }
    this.expect('=');
    const init = this.expr();
    this.expect(';');
    return {
      k: 'let', span: this.join(kw.span, this.prevSpan()), name: name.text, nameSpan: name.span,
      mutable: kw.kind === 'var', annot, annotSpan, init,
    };
  }

  ifStmt(): Stmt {
    const kw = this.next();
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
    this.allowStruct(() => {
      while (!this.at('}') && !this.at('eof')) {
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
    return { k: 'structlit', name: nameTok.text, nameSpan: nameTok.span, fields, span: this.join(nameTok.span, close.span), ty: 'error' };
  }

  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.at('[')) {
        this.next();
        const idx = this.allowStruct(() => this.expr());
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
        const f = this.expect('ident', 'a field name');
        if (this.at('(')) {
          this.next();
          const args: Expr[] = [];
          if (!this.at(')')) {
            do args.push(this.allowStruct(() => this.expr())); while (this.eat(',') && !this.at(')'));
          }
          const close = this.expect(')');
          e = { k: 'mcall', obj: e, name: f.text, nameSpan: f.span, args, span: this.join(e.span, close.span), ty: 'error' };
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
        this.expect(')');
        return e;
      }
      case 'if': return this.ifExpr(t);
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
          const value = this.allowStruct(() => this.expr());
          arms.push({ pats, guard, value, span: this.join(first, value.span) });
          if (!this.eat(',')) break;
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
    if (this.at('{') && !this.noStruct) return this.structLit(t);
    if (!this.at('(')) return { k: 'var', name: t.text, span: t.span, ty: 'error' };
    this.next();
    const args: Expr[] = [];
    if (!this.at(')')) {
      do args.push(this.allowStruct(() => this.expr())); while (this.eat(',') && !this.at(')'));
    }
    const close = this.expect(')');
    return { k: 'call', name: t.text, nameSpan: t.span, args, span: this.join(t.span, close.span), ty: 'error' };
  }
}

export function parse(src: string, segments: Segment[] = []): { program: Program; diags: Diagnostic[] } {
  const { tokens, diags } = lex(src);
  const p = new Parser(tokens, diags, segments);
  const program = p.program();
  return { program, diags };
}
