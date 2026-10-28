import type { Diagnostic, Severity, Span } from './diagnostics.ts';
import type { Expr, FnDecl, FnSym, Program, Stmt, VarSym } from './ast.ts';
import { BUILTINS, isBuiltin, isNumeric } from './types.ts';
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
  globals = new Scope(null);
  scope = this.globals;
  ctx: FnCtx = { ret: 'void', nlocals: 0, isMain: true, name: '<main>' };
  nglobals = 0;
  loops: { sawBreak: boolean }[] = [];
  allVars: VarSym[] = [];

  report(severity: Severity, code: string, message: string, span: Span, hint?: string) {
    this.diags.push({ severity, code, message, span, hint });
  }
  err(code: string, message: string, span: Span, hint?: string) { this.report('error', code, message, span, hint); }
  warn(code: string, message: string, span: Span, hint?: string) { this.report('warning', code, message, span, hint); }

  run(prog: Program) {
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

  declareFn(f: FnDecl) {
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

      case 'let': {
        const t = this.expr(s.init);
        let ty: Type = s.annot ?? t;
        if (t === 'void') {
          this.err('E010', 'a function that returns nothing cannot be used as a value', s.init.span);
          ty = 'error';
        } else if (s.annot && t !== 'error' && t !== s.annot) {
          this.mismatch(s.annot, t, s.init.span);
        }
        // declared after the initializer so `let x = x + 1` sees the outer x
        s.sym = this.declareVar(s.name, ty, s.mutable, s.nameSpan);
        return NEXT;
      }

      case 'assign': {
        const t = this.expr(s.value);
        const sym = this.scope.lookup(s.name);
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
          const t = this.expr(s.value);
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

  expr(e: Expr): Type {
    const t = this.expr0(e);
    e.ty = t;
    return t;
  }

  expr0(e: Expr): Type {
    switch (e.k) {
      case 'int': return 'int';
      case 'float': return 'float';
      case 'str': return 'string';
      case 'bool': return 'bool';

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
        if (a === b && a !== 'void') return 'bool';
        return opErr(`cannot compare ${a} with ${b}`, sameHint);
      case '&&': case '||':
        if (a === 'bool' && b === 'bool') return 'bool';
        return opErr(`'${e.op}' needs bool operands, found ${a} and ${b}`);
    }
  }

  call(e: Extract<Expr, { k: 'call' }>): Type {
    const argTys = e.args.map(a => this.expr(a));

    if (isBuiltin(e.name)) {
      const sig = BUILTINS[e.name];
      e.builtin = e.name;
      if (e.args.length !== 1) {
        this.err('E004', `'${e.name}' takes 1 argument, but ${e.args.length} were given`, e.span);
      } else if (argTys[0] !== 'error' && !sig.accepts.includes(argTys[0])) {
        const msg = argTys[0] === 'void'
          ? 'a function that returns nothing cannot be used as a value'
          : `'${e.name}' does not accept ${argTys[0]} (expected ${sig.accepts.join(' | ')})`;
        this.err(argTys[0] === 'void' ? 'E010' : 'E003', msg, e.args[0].span);
      }
      return sig.ret;
    }

    const fn = this.fns.get(e.name);
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
