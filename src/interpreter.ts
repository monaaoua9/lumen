import { RuntimeError } from './diagnostics.ts';
import type { Expr, FnDecl, Program, Stmt } from './ast.ts';
import { MAX_DEPTH, callBuiltin, checkInt, intDiv, intMod } from './runtime.ts';
import type { IO, Value } from './runtime.ts';

const NORMAL = 0;
const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;

interface Frame {
  locals: Value[];
  ret: Value;
}

export class Interpreter {
  globals: Value[];
  io: IO;
  depth = 0;

  constructor(prog: Program, io: IO) {
    this.io = io;
    this.globals = new Array(prog.nglobals).fill(null);
  }

  run(prog: Program) {
    const main: Frame = { locals: new Array(prog.nlocals).fill(null), ret: null };
    try {
      this.exec(prog.body, main);
    } catch (e) {
      if (e instanceof RangeError) throw new RuntimeError('stack overflow');
      throw e;
    }
  }

  exec(body: Stmt[], f: Frame): number {
    for (const s of body) {
      const sig = this.stmt(s, f);
      if (sig !== NORMAL) return sig;
    }
    return NORMAL;
  }

  stmt(s: Stmt, f: Frame): number {
    switch (s.k) {
      case 'fn': return NORMAL;

      case 'let':
      case 'assign': {
        const v = this.eval(s.k === 'let' ? s.init : s.value, f);
        const sym = s.sym!;
        if (sym.where === 'global') this.globals[sym.slot] = v;
        else f.locals[sym.slot] = v;
        return NORMAL;
      }

      case 'expr':
        this.eval(s.e, f);
        return NORMAL;

      case 'if':
        if (this.eval(s.cond, f)) return this.exec(s.then, f);
        return s.els ? this.exec(s.els, f) : NORMAL;

      case 'while':
        while (this.eval(s.cond, f)) {
          const sig = this.exec(s.body, f);
          if (sig === BREAK) break;
          if (sig === RETURN) return sig;
        }
        return NORMAL;

      case 'return':
        f.ret = s.value ? this.eval(s.value, f) : null;
        return RETURN;

      case 'break': return BREAK;
      case 'continue': return CONTINUE;
      case 'block': return this.exec(s.body, f);
    }
  }

  eval(e: Expr, f: Frame): Value {
    switch (e.k) {
      case 'int':
      case 'float':
      case 'str':
      case 'bool':
        return e.value;

      case 'var': {
        const sym = e.sym!;
        return sym.where === 'global' ? this.globals[sym.slot] : f.locals[sym.slot];
      }

      case 'unary': {
        const v = this.eval(e.arg, f);
        return e.op === '!' ? !v : -(v as number);
      }

      case 'binary': {
        if (e.op === '&&') return this.eval(e.l, f) && this.eval(e.r, f);
        if (e.op === '||') return this.eval(e.l, f) || this.eval(e.r, f);
        const a = this.eval(e.l, f) as number;
        const b = this.eval(e.r, f) as number;
        const isInt = e.l.ty === 'int';
        switch (e.op) {
          case '+': return e.l.ty === 'string' ? (a as unknown as string) + (b as unknown as string) : isInt ? checkInt(a + b, e.span) : a + b;
          case '-': return isInt ? checkInt(a - b, e.span) : a - b;
          case '*': return isInt ? checkInt(a * b, e.span) : a * b;
          case '/': return isInt ? intDiv(a, b, e.span) : a / b;
          case '%': return intMod(a, b, e.span);
          case '==': return a === b;
          case '!=': return a !== b;
          case '<': return a < b;
          case '<=': return a <= b;
          case '>': return a > b;
          case '>=': return a >= b;
        }
        return null;
      }

      case 'call': {
        if (e.builtin) return callBuiltin(e.builtin, this.eval(e.args[0], f), e.args[0].ty, this.io, e.span);
        return this.callFn(e.fn!.decl, e.args.map(a => this.eval(a, f)), e.span);
      }
    }
  }

  callFn(fn: FnDecl, args: Value[], span: Expr['span']): Value {
    if (this.depth >= MAX_DEPTH) throw new RuntimeError('stack overflow', span);
    const locals = new Array(fn.nlocals).fill(null);
    for (let i = 0; i < args.length; i++) locals[i] = args[i];
    const frame: Frame = { locals, ret: null };
    this.depth++;
    this.exec(fn.body, frame);
    this.depth--;
    return frame.ret;
  }
}

export function interpret(prog: Program, io: IO) {
  new Interpreter(prog, io).run(prog);
}
