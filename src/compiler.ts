import type { Span } from './diagnostics.ts';
import type { Expr, Program, Stmt } from './ast.ts';
import { Op, TYPE_TAGS } from './bytecode.ts';
import type { Module, Proto } from './bytecode.ts';
import type { Value } from './runtime.ts';

class FnCompiler {
  code: number[] = [];
  spans: (Span | undefined)[] = [];
  loops: { start: number; breaks: number[] }[] = [];
  span: Span | undefined;
  consts: Value[];
  pool: Map<string, number>;

  constructor(consts: Value[], pool: Map<string, number>) {
    this.consts = consts;
    this.pool = pool;
  }

  emit(op: number, ...args: number[]) {
    this.spans[this.code.length] = this.span;
    this.code.push(op, ...args);
  }

  jump(op: number): number {
    this.emit(op, -1);
    return this.code.length - 1;
  }

  patch(at: number) {
    this.code[at] = this.code.length;
  }

  konst(v: Value) {
    const key = typeof v + ':' + String(v);
    let idx = this.pool.get(key);
    if (idx === undefined) {
      idx = this.consts.length;
      this.consts.push(v);
      this.pool.set(key, idx);
    }
    this.emit(Op.CONST, idx);
  }

  block(body: Stmt[]) {
    for (const s of body) this.stmt(s);
  }

  stmt(s: Stmt) {
    this.span = s.span;
    switch (s.k) {
      case 'fn': return;

      case 'let':
      case 'assign': {
        this.expr(s.k === 'let' ? s.init : s.value);
        const sym = s.sym!;
        this.span = s.span;
        this.emit(sym.where === 'global' ? Op.STOREG : Op.STOREL, sym.slot);
        return;
      }

      case 'expr':
        this.expr(s.e);
        if (s.e.ty !== 'void') this.emit(Op.POP);
        return;

      case 'if': {
        this.expr(s.cond);
        const toElse = this.jump(Op.JMPF);
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
        this.expr(s.cond);
        const exit = this.jump(Op.JMPF);
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
        this.expr(e.l);
        this.expr(e.r);
        this.span = e.span;
        this.emit(this.binOp(e));
        return;
      }

      case 'call': {
        e.args.forEach(a => this.expr(a));
        this.span = e.span;
        if (!e.builtin) {
          this.emit(Op.CALL, e.fn!.index);
          return;
        }
        const argTy = e.args[0].ty;
        switch (e.builtin) {
          case 'print': this.emit(Op.PRINT, TYPE_TAGS.indexOf(argTy)); break;
          case 'str': this.emit(Op.STR, TYPE_TAGS.indexOf(argTy)); break;
          case 'int': if (argTy === 'float') this.emit(Op.F2I); break;
          case 'len': this.emit(Op.LEN); break;
          case 'float': break; // same representation as int
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
  const fns: Proto[] = [];

  const build = (name: string, arity: number, nlocals: number, returns: boolean, body: Stmt[], tail: number): Proto => {
    const c = new FnCompiler(consts, pool);
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
  return { consts, fns, main, nglobals: prog.nglobals };
}
