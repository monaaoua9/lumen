import type { Expr, FnDecl, Program, Stmt, VarSym } from './ast.ts';

// builtins whose result never points into their string argument
const FRESH = new Set(['print', 'len', 'find', 'byte', 'starts_with', 'ends_with', 'parse_int', 'parse_float', 'substr', 'trim', 'split']);
const READS = new Set(['+', '==', '!=', '<', '<=', '>', '>=']);

// string variables that are only ever appended to or read in ways that cannot keep a second pointer to
// their buffer. the C backend grows those in place, so `s += x` in a loop stops copying the whole string
export function findBuilders(prog: Program): Set<VarSym> {
  const cands = new Set<VarSym>();
  const bad = new Set<VarSym>();
  const seen = new Set<FnDecl>();
  let collect = true;

  // a read that does not keep the pointer: a candidate itself is fine here, anything else is looked at strictly
  const read = (e: Expr) => {
    if (e.k === 'var') return;
    strict(e);
  };

  const fn = (f: FnDecl) => {
    if (seen.has(f)) return;
    seen.add(f);
    stmts(f.body);
  };

  const strict = (e: Expr): void => {
    switch (e.k) {
      case 'var':
        if (e.sym && cands.has(e.sym)) bad.add(e.sym);
        return;
      case 'int': case 'float': case 'str': case 'bool': case 'fnref': case 'enumval':
        return;
      case 'lambda':
        e.caps.forEach(strict);
        fn(e.fn);
        return;
      case 'unary': strict(e.arg); return;
      case 'binary':
        if (READS.has(e.op)) {
          read(e.l);
          read(e.r);
        } else {
          strict(e.l);
          strict(e.r);
        }
        return;
      case 'array': e.elems.forEach(strict); return;
      case 'index':
        if (e.arr.k === 'var' && e.arr.ty === 'string') read(e.arr);
        else strict(e.arr);
        strict(e.idx);
        return;
      case 'blockx': stmts(e.body); strict(e.value); return;
      case 'matchx':
        strict(e.scrut);
        for (const a of e.arms) {
          if (a.guard) strict(a.guard);
          strict(a.value);
        }
        return;
      case 'enumctor': e.args.forEach(strict); return;
      case 'mcall': strict(e.obj); e.args.forEach(strict); return;
      case 'field': strict(e.obj); return;
      case 'structlit':
        e.fields.forEach(f => strict(f.value));
        if (e.base) strict(e.base);
        return;
      case 'call':
        if (e.callee) strict(e.callee);
        if (e.builtin && FRESH.has(e.builtin)) e.args.forEach(read);
        else e.args.forEach(strict);
        return;
    }
    // a node kind this walker does not know: give up on everything
    for (const c of cands) bad.add(c);
  };

  const stmt = (s: Stmt): void => {
    switch (s.k) {
      case 'let':
        if (collect && s.sym && s.mutable && s.sym.ty === 'string' && !s.sym.box && !s.sym.isParam) cands.add(s.sym);
        strict(s.init);
        return;
      case 'assign': {
        const v = s.value;
        if (s.sym && cands.has(s.sym) && v.k === 'binary' && v.op === '+' && v.l.k === 'var' && v.l.sym === s.sym) strict(v.r);
        else strict(v);
        return;
      }
      case 'match':
        strict(s.scrut);
        for (const a of s.arms) {
          if (a.guard) strict(a.guard);
          stmts(a.body);
        }
        return;
      case 'setfield': strict(s.obj); strict(s.value); return;
      case 'setindex': strict(s.arr); strict(s.idx); strict(s.value); return;
      case 'expr': strict(s.e); return;
      case 'if':
        strict(s.cond);
        stmts(s.then);
        if (s.els) stmts(s.els);
        return;
      case 'while': strict(s.cond); stmts(s.body); return;
      case 'return':
        if (s.value) read(s.value);
        return;
      case 'block': stmts(s.body); return;
      case 'fn': fn(s); return;
      case 'break': case 'continue': case 'struct': case 'enum':
        return;
    }
    for (const c of cands) bad.add(c);
  };

  const stmts = (b: Stmt[]) => b.forEach(stmt);

  const all = () => {
    stmts(prog.body);
    prog.fns.forEach(fn);
  };
  all();
  collect = false;
  seen.clear();
  all();

  const out = new Set<VarSym>();
  for (const c of cands) if (!bad.has(c)) out.add(c);
  return out;
}
