import type { Span } from './diagnostics.ts';
import type { Expr, Pat, Program, Stmt } from './ast.ts';
import { Op } from './bytecode.ts';
import type { Module, Proto } from './bytecode.ts';
import type { Type } from './types.ts';
import type { Value } from './runtime.ts';

// `a < b` feeding an if/while compiles to one compare-and-branch op instead of LT + JMPF
const FUSED: Record<string, number> = {
  '<': Op.JFLT, '<=': Op.JFLE, '>': Op.JFGT, '>=': Op.JFGE, '==': Op.JFEQ, '!=': Op.JFNE,
};

class FnCompiler {
  code: number[] = [];
  spans: (Span | undefined)[] = [];
  loops: { start: number; breaks: number[] }[] = [];
  span: Span | undefined;
  consts: Value[];
  pool: Map<string, number>;
  types: Type[];

  constructor(consts: Value[], pool: Map<string, number>, types: Type[]) {
    this.consts = consts;
    this.pool = pool;
    this.types = types;
  }

  typeIdx(t: Type): number {
    const i = this.types.indexOf(t);
    if (i >= 0) return i;
    this.types.push(t);
    return this.types.length - 1;
  }

  emit(op: number, ...args: number[]) {
    // every cell of the instruction gets the span, so the VM can look up pc - 1 without tracking where the op started
    for (let i = 0; i <= args.length; i++) this.spans[this.code.length + i] = this.span;
    this.code.push(op, ...args);
  }

  // evaluates a condition, returns the jump to patch for "condition is false"
  condJump(e: Expr): number {
    if (e.k === 'binary' && FUSED[e.op] !== undefined) {
      this.expr(e.l);
      this.expr(e.r);
      this.span = e.span;
      return this.jump(FUSED[e.op]);
    }
    this.expr(e);
    return this.jump(Op.JMPF);
  }

  jump(op: number): number {
    this.emit(op, -1);
    return this.code.length - 1;
  }

  patch(at: number) {
    this.code[at] = this.code.length;
  }

  poolIdx(v: Value): number {
    const key = typeof v + ':' + String(v);
    let idx = this.pool.get(key);
    if (idx === undefined) {
      idx = this.consts.length;
      this.consts.push(v);
      this.pool.set(key, idx);
    }
    return idx;
  }

  konst(v: Value) {
    this.emit(Op.CONST, this.poolIdx(v));
  }

  // tests the scrutinee (in local `tmp`) against the patterns. falls into the arm body on a match,
  // returns the jump to patch for "no match" (or -1 when a `_` makes the arm unconditional)
  armTest(tmp: number, pats: Pat[]): number {
    const toBody: number[] = [];
    let wild = false;
    for (const p of pats) {
      if (p.k === 'wild') {
        wild = true;
        break;
      }
      this.emit(Op.LOADL, tmp);
      if (p.k === 'variant' && p.boxed) this.emit(Op.GETF, 0);
      this.konst(p.k === 'variant' ? p.idx : p.value);
      this.emit(Op.EQ);
      const skip = this.jump(Op.JMPF);
      toBody.push(this.jump(Op.JMP));
      this.patch(skip);
    }
    const next = wild ? -1 : this.jump(Op.JMP);
    toBody.forEach(j => this.patch(j));
    return next;
  }

  // copy `Variant(a, b)` payload values into the binding slots
  bindArm(tmp: number, pats: Pat[]) {
    const p = pats[0];
    if (pats.length !== 1 || p.k !== 'variant' || !p.binds) return;
    p.binds.forEach((b, j) => {
      if (!b?.sym) return;
      this.emit(Op.LOADL, tmp);
      this.emit(Op.GETF, j + 1);
      this.emit(Op.STOREL, b.sym.slot);
    });
  }

  block(body: Stmt[]) {
    for (const s of body) this.stmt(s);
  }

  stmt(s: Stmt) {
    this.span = s.span;
    switch (s.k) {
      case 'fn':
      case 'struct':
      case 'enum':
        return;

      case 'match': {
        this.expr(s.scrut);
        this.span = s.span;
        this.emit(Op.STOREL, s.tmp);
        const ends: number[] = [];
        for (const arm of s.arms) {
          const next = this.armTest(s.tmp, arm.pats);
          this.bindArm(s.tmp, arm.pats);
          this.block(arm.body);
          ends.push(this.jump(Op.JMP));
          if (next >= 0) this.patch(next);
        }
        ends.forEach(j => this.patch(j));
        return;
      }

      case 'let':
      case 'assign': {
        this.expr(s.k === 'let' ? s.init : s.value);
        const sym = s.sym!;
        this.span = s.span;
        this.emit(sym.where === 'global' ? Op.STOREG : Op.STOREL, sym.slot);
        return;
      }

      case 'setfield':
        this.expr(s.obj);
        this.expr(s.value);
        this.span = s.span;
        this.emit(Op.SETF, s.idx);
        return;

      case 'setindex':
        this.expr(s.arr);
        this.expr(s.idx);
        this.expr(s.value);
        this.span = s.span;
        this.emit(Op.SETINDEX);
        return;

      case 'expr':
        this.expr(s.e);
        if (s.e.ty !== 'void') this.emit(Op.POP);
        return;

      case 'if': {
        const toElse = this.condJump(s.cond);
        this.block(s.then);
        if (s.els) {
          const toEnd = this.jump(Op.JMP);
          this.patch(toElse);
          this.block(s.els);
          this.patch(toEnd);
        } else {
          this.patch(toElse);
        }
        return;
      }

      case 'while': {
        const loop = { start: this.code.length, breaks: [] as number[] };
        this.loops.push(loop);
        const exit = this.condJump(s.cond);
        this.block(s.body);
        this.emit(Op.JMP, loop.start);
        this.patch(exit);
        for (const b of loop.breaks) this.patch(b);
        this.loops.pop();
        return;
      }

      case 'return':
        if (s.value) {
          this.expr(s.value);
          this.span = s.span;
          this.emit(Op.RET);
        } else {
          this.emit(Op.RETV);
        }
        return;

      case 'break':
        this.loops[this.loops.length - 1].breaks.push(this.jump(Op.JMP));
        return;

      case 'continue':
        this.emit(Op.JMP, this.loops[this.loops.length - 1].start);
        return;

      case 'block':
        this.block(s.body);
        return;
    }
  }

  expr(e: Expr) {
    this.span = e.span;
    switch (e.k) {
      case 'int':
      case 'float':
      case 'str':
      case 'bool':
        this.konst(e.value);
        return;

      case 'var':
        this.emit(e.sym!.where === 'global' ? Op.LOADG : Op.LOADL, e.sym!.slot);
        return;

      case 'lambda':
        if (e.caps.length === 0) {
          this.emit(Op.CONST, this.poolIdx(e.fn.sym!.index));
        } else {
          e.caps.forEach(c => this.expr(c));
          this.emit(Op.MKCLO, e.fn.sym!.index, e.caps.length);
        }
        return;

      case 'fnref':
        this.emit(Op.CONST, this.poolIdx(e.fn!.index));
        return;

      case 'unary':
        this.expr(e.arg);
        this.span = e.span;
        this.emit(e.op === '-' ? Op.NEG : Op.NOT);
        return;

      case 'binary': {
        if (e.op === '&&' || e.op === '||') {
          this.expr(e.l);
          this.emit(Op.DUP);
          if (e.op === '||') this.emit(Op.NOT);
          const end = this.jump(Op.JMPF);
          this.emit(Op.POP);
          this.expr(e.r);
          this.patch(end);
          return;
        }
        // `x + 3` / `x - 3` on an int variable is one instruction (superinstruction)
        if ((e.op === '+' || e.op === '-') && e.l.ty === 'int' && e.l.k === 'var' && e.r.k === 'int') {
          this.span = e.span;
          this.emit(e.l.sym!.where === 'global' ? Op.ADDGI : Op.ADDLI, e.l.sym!.slot, e.op === '+' ? e.r.value : -e.r.value);
          return;
        }
        this.expr(e.l);
        this.expr(e.r);
        this.span = e.span;
        this.emit(this.binOp(e));
        return;
      }

      case 'array':
        e.elems.forEach(x => this.expr(x));
        this.span = e.span;
        this.emit(Op.NEWARR, e.elems.length);
        return;

      case 'enumval':
        this.konst(e.idx);
        if (e.boxed) this.emit(Op.NEWARR, 1);
        return;

      case 'enumctor':
        this.konst(e.idx);
        e.args.forEach(a => this.expr(a));
        this.span = e.span;
        this.emit(Op.NEWARR, e.args.length + 1);
        return;

      case 'matchx': {
        this.expr(e.scrut);
        this.span = e.span;
        this.emit(Op.STOREL, e.tmp);
        const ends: number[] = [];
        for (const arm of e.arms) {
          const next = this.armTest(e.tmp, arm.pats);
          this.bindArm(e.tmp, arm.pats);
          this.expr(arm.value);
          ends.push(this.jump(Op.JMP));
          if (next >= 0) this.patch(next);
        }
        ends.forEach(j => this.patch(j));
        return;
      }

      case 'field':
        this.expr(e.obj);
        this.span = e.span;
        this.emit(Op.GETF, e.idx);
        return;

      case 'structlit': {
        e.fields.forEach(f => this.expr(f.value));
        this.span = e.span;
        this.emit(Op.NEWARR, e.fields.length);
        // values were pushed in source order, put them in declaration order
        if (e.fields.some((f, i) => f.idx !== i)) {
          const perm = e.fields.map(f => f.idx);
          this.emit(Op.REORDER, this.poolIdx(perm));
        }
        return;
      }

      case 'index':
        this.expr(e.arr);
        this.expr(e.idx);
        this.span = e.span;
        this.emit(Op.INDEX);
        return;

      case 'call': {
        e.args.forEach(a => this.expr(a));
        this.span = e.span;
        if (e.callee) {
          this.expr(e.callee);
          this.span = e.span;
          this.emit(Op.CALLI);
          return;
        }
        if (!e.builtin) {
          this.emit(Op.CALL, e.fn!.index);
          return;
        }
        const argTy = e.args[0].ty;
        switch (e.builtin) {
          case 'print': this.emit(Op.PRINT, this.typeIdx(argTy)); break;
          case 'str': this.emit(Op.STR, this.typeIdx(argTy)); break;
          case 'int': if (argTy === 'float') this.emit(Op.F2I); break;
          case 'len': this.emit(Op.LEN); break;
          case 'push': this.emit(Op.PUSHA); break;
          case 'pop': this.emit(Op.POPA); break;
          case 'float': break; // same representation as int
          case 'sqrt': this.emit(Op.SQRT); break;
          case 'substr': this.emit(Op.SUBSTR); break;
          case 'find': this.emit(Op.FIND); break;
          case 'split': this.emit(Op.SPLIT); break;
          case 'abs': this.emit(Op.ABS); break;
          case 'min': this.emit(Op.MIN); break;
          case 'max': this.emit(Op.MAX); break;
        }
      }
    }
  }

  binOp(e: Extract<Expr, { k: 'binary' }>): number {
    const t = e.l.ty;
    switch (e.op) {
      case '+': return t === 'string' ? Op.CAT : t === 'int' ? Op.ADD : Op.FADD;
      case '-': return t === 'int' ? Op.SUB : Op.FSUB;
      case '*': return t === 'int' ? Op.MUL : Op.FMUL;
      case '/': return t === 'int' ? Op.DIV : Op.FDIV;
      case '%': return Op.MOD;
      case '==': return Op.EQ;
      case '!=': return Op.NE;
      case '<': return Op.LT;
      case '<=': return Op.LE;
      case '>': return Op.GT;
      case '>=': return Op.GE;
    }
    throw new Error('unreachable binop ' + e.op);
  }
}

export function compile(prog: Program): Module {
  const consts: Value[] = [];
  const pool = new Map<string, number>();
  const types: Type[] = [];
  const fns: Proto[] = [];

  const build = (name: string, arity: number, nlocals: number, returns: boolean, body: Stmt[], tail: number): Proto => {
    const c = new FnCompiler(consts, pool, types);
    c.block(body);
    c.span = undefined;
    c.emit(tail);
    return { name, arity, nlocals, returns, code: c.code, spans: c.spans };
  };

  for (const f of prog.fns) {
    if (!f.sym) continue;
    fns[f.sym.index] = build(f.name, f.params.length, f.nlocals, f.ret !== 'void', f.body, Op.RETV);
  }

  const main = build('<main>', 0, prog.nlocals, false, prog.body, Op.HALT);
  const structs = prog.structs.map(d => ({ name: d.name, shown: d.shown, fields: d.fields.map(f => ({ name: f.name, ty: f.ty })) }));
  const enums = prog.enums.map(d => ({ name: d.name, variants: d.variants.map(v => ({ name: v.name, payload: v.payload })) }));
  return { consts, types, structs, enums, fns, main, nglobals: prog.nglobals };
}
