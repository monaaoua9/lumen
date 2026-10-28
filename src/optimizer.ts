import type { Expr, Program, Stmt } from './ast.ts';

// constant folding + dead branch removal on the typed AST. only touches
// literals, anything that could trap at runtime (div by zero, overflow) is left alone

type Lit = Extract<Expr, { k: 'int' | 'float' | 'str' | 'bool' }>;

const isLit = (e: Expr): e is Lit => e.k === 'int' || e.k === 'float' || e.k === 'str' || e.k === 'bool';

function lit(e: Expr, value: number | string | boolean): Expr {
  if (typeof value === 'number' && !Number.isFinite(value)) return e; // inf/nan have no literal form
  const base = { span: e.span };
  if (typeof value === 'boolean') return { ...base, k: 'bool', value, ty: 'bool' };
  if (typeof value === 'string') return { ...base, k: 'str', value, ty: 'string' };
  return e.ty === 'int' || (e.ty !== 'float' && Number.isInteger(value))
    ? { ...base, k: 'int', value, ty: 'int' }
    : { ...base, k: 'float', value, ty: 'float' };
}

function foldExpr(e: Expr): Expr {
  switch (e.k) {
    case 'unary': {
      e.arg = foldExpr(e.arg);
      if (!isLit(e.arg)) return e;
      if (e.op === '!') return lit(e, !e.arg.value);
      return lit(e, -(e.arg.value as number));
    }

    case 'binary': {
      e.l = foldExpr(e.l);
      e.r = foldExpr(e.r);
      if (!isLit(e.l) || !isLit(e.r)) return e;
      const a = e.l.value as number;
      const b = e.r.value as number;
      const isInt = e.l.ty === 'int';
      switch (e.op) {
        case '+':
          if (e.l.ty === 'string') return lit(e, (e.l.value as string) + (e.r.value as string));
          return isInt && !Number.isSafeInteger(a + b) ? e : lit(e, a + b);
        case '-': return isInt && !Number.isSafeInteger(a - b) ? e : lit(e, a - b);
        case '*': return isInt && !Number.isSafeInteger(a * b) ? e : lit(e, a * b);
        case '/':
          if (isInt) return b === 0 ? e : lit(e, Math.trunc(a / b));
          return lit(e, a / b);
        case '%': return b === 0 ? e : lit(e, a % b);
        case '==': return lit(e, e.l.value === e.r.value);
        case '!=': return lit(e, e.l.value !== e.r.value);
        case '<': return lit(e, a < b);
        case '<=': return lit(e, a <= b);
        case '>': return lit(e, a > b);
        case '>=': return lit(e, a >= b);
        case '&&': return lit(e, (e.l.value as boolean) && (e.r.value as boolean));
        case '||': return lit(e, (e.l.value as boolean) || (e.r.value as boolean));
      }
      return e;
    }

    case 'call':
      e.args = e.args.map(foldExpr);
      return e;

    case 'array':
      e.elems = e.elems.map(foldExpr);
      return e;

    case 'index':
      e.arr = foldExpr(e.arr);
      e.idx = foldExpr(e.idx);
      return e;

    case 'field':
      e.obj = foldExpr(e.obj);
      return e;

    case 'structlit':
      e.fields.forEach(f => { f.value = foldExpr(f.value); });
      return e;

    default:
      return e;
  }
}

function foldBlock(body: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (const s of body) {
    const r = foldStmt(s);
    if (r) out.push(r);
  }
  return out;
}

function foldStmt(s: Stmt): Stmt | null {
  switch (s.k) {
    case 'fn':
      s.body = foldBlock(s.body);
      return s;
    case 'let':
      s.init = foldExpr(s.init);
      return s;
    case 'assign':
      s.value = foldExpr(s.value);
      return s;
    case 'expr':
      s.e = foldExpr(s.e);
      return s;
    case 'match':
      s.scrut = foldExpr(s.scrut);
      s.arms.forEach(a => { a.body = foldBlock(a.body); });
      return s;
    case 'setfield':
      s.obj = foldExpr(s.obj);
      s.value = foldExpr(s.value);
      return s;
    case 'setindex':
      s.arr = foldExpr(s.arr);
      s.idx = foldExpr(s.idx);
      s.value = foldExpr(s.value);
      return s;
    case 'return':
      if (s.value) s.value = foldExpr(s.value);
      return s;
    case 'block':
      s.body = foldBlock(s.body);
      return s;
    case 'if': {
      s.cond = foldExpr(s.cond);
      s.then = foldBlock(s.then);
      if (s.els) s.els = foldBlock(s.els);
      if (s.cond.k === 'bool') {
        const taken = s.cond.value ? s.then : s.els;
        return taken ? { k: 'block', span: s.span, body: taken } : null;
      }
      return s;
    }
    case 'while':
      s.cond = foldExpr(s.cond);
      s.body = foldBlock(s.body);
      if (s.cond.k === 'bool' && !s.cond.value) return null;
      return s;
    default:
      return s;
  }
}

export function optimize(prog: Program): Program {
  prog.body = foldBlock(prog.body);
  return prog;
}
