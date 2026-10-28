import type { Diagnostic, Span } from './diagnostics.ts';
import type { BinOp, Expr, FieldInit, FnDecl, Param, Program, Stmt, StructDecl, StructField } from './ast.ts';
import { lex } from './lexer.ts';
import type { Token } from './lexer.ts';
import { arrayOf, structType, typeFromName } from './types.ts';
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
  structs: StructDecl[] = [];
  noStruct = false; // `if x {` must not parse as a struct literal
  depth = 0; // block nesting, fn is only legal at 0

  constructor(toks: Token[], diags: Diagnostic[]) {
    this.toks = toks;
    this.diags = diags;
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
    return { body, fns: this.fns, structs: this.structs, nlocals: 0, nglobals: 0 };
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
    const starts = new Set(['fn', 'struct', 'let', 'var', 'if', 'while', 'return', 'break', 'continue']);
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
    const t = this.expect('ident', 'a type name');
    // anything that is not a builtin type is assumed to be a struct, the analyzer checks it exists
    const ty = (typeFromName(t.text) ?? structType(t.text)) as Elem;
    if (this.eat('[')) {
      this.expect(']');
      return arrayOf(ty);
    }
    return ty;
  }

  statement(): Stmt {
    const t = this.cur;
    switch (t.kind) {
      case 'fn': return this.fnDecl();
      case 'struct': return this.structDecl();
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
        const value: Expr = nx === '='
          ? rhs
          : { k: 'binary', op: COMPOUND[nx], l: { k: 'var', name: t.text, span: t.span, ty: 'error' }, r: rhs, span: this.join(t.span, rhs.span), ty: 'error' };
        return { k: 'assign', span: this.join(t.span, this.prevSpan()), name: t.text, nameSpan: t.span, value };
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

  structDecl(): StructDecl {
    const kw = this.next();
    if (this.depth > 0) {
      this.diags.push({ severity: 'error', code: 'P002', message: 'structs can only be declared at the top level', span: kw.span });
    }
    const name = this.expect('ident', 'a struct name');
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
    const decl: StructDecl = { k: 'struct', span: this.join(kw.span, name.span), name: name.text, nameSpan: name.span, fields };
    this.structs.push(decl);
    return decl;
  }

  fnDecl(): FnDecl {
    const kw = this.next();
    if (this.depth > 0) {
      this.diags.push({ severity: 'error', code: 'P002', message: 'functions can only be declared at the top level', span: kw.span });
    }
    const name = this.expect('ident', 'a function name');
    this.expect('(');
    const params: Param[] = [];
    if (!this.at(')')) {
      do {
        const p = this.expect('ident', 'a parameter name');
        this.expect(':');
        params.push({ name: p.text, span: p.span, ty: this.type() });
      } while (this.eat(','));
    }
    this.expect(')');
    const ret: Type = this.eat(':') ? this.type() : 'void';
    const body = this.block();
    const decl: FnDecl = { k: 'fn', span: this.join(kw.span, name.span), name: name.text, nameSpan: name.span, params, ret, body, nlocals: 0 };
    this.fns.push(decl);
    return decl;
  }

  letStmt(): Stmt {
    const kw = this.next();
    const name = this.expect('ident', 'a variable name');
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
        this.expect(':');
        fields.push({ name: f.text, nameSpan: f.span, value: this.expr(), idx: -1 });
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
      } else if (this.at('.')) {
        this.next();
        const f = this.expect('ident', 'a field name');
        e = { k: 'field', obj: e, name: f.text, nameSpan: f.span, idx: -1, span: this.join(e.span, f.span), ty: 'error' };
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
      case '[': {
        const elems: Expr[] = [];
        if (!this.at(']')) {
          do elems.push(this.allowStruct(() => this.expr())); while (this.eat(','));
        }
        const close = this.expect(']');
        return { k: 'array', elems, span: this.join(t.span, close.span), ty: 'error' };
      }
      case 'ident': {
        if (this.at('{') && !this.noStruct) return this.structLit(t);
        if (!this.at('(')) return { k: 'var', name: t.text, span: t.span, ty: 'error' };
        this.next();
        const args: Expr[] = [];
        if (!this.at(')')) {
          do args.push(this.allowStruct(() => this.expr())); while (this.eat(','));
        }
        const close = this.expect(')');
        return { k: 'call', name: t.text, nameSpan: t.span, args, span: this.join(t.span, close.span), ty: 'error' };
      }
    }
    const found = t.kind === 'eof' ? 'end of file' : `'${t.text}'`;
    if (t.kind !== 'eof') this.pos--; // leave the bad token for sync() to skip
    this.fail(`expected an expression, found ${found}`, t.span);
  }
}

export function parse(src: string): { program: Program; diags: Diagnostic[] } {
  const { tokens, diags } = lex(src);
  const p = new Parser(tokens, diags);
  const program = p.program();
  return { program, diags };
}
