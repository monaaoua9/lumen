import { RuntimeError } from './diagnostics.ts';
import { Op, TYPE_TAGS } from './bytecode.ts';
import type { Module, Proto } from './bytecode.ts';
import { MAX_DEPTH, checkIndex, checkInt, floatToInt, format, intDiv, intMod } from './runtime.ts';
import type { IO, Value } from './runtime.ts';

interface CallFrame {
  proto: Proto;
  pc: number;
  bp: number;
}

const STACK_SIZE = 1 << 16;

export function run(m: Module, io: IO) {
  const stack: Value[] = new Array(STACK_SIZE).fill(null);
  const globals: Value[] = new Array(m.nglobals).fill(null);
  const frames: CallFrame[] = [];

  let proto = m.main;
  let code = proto.code;
  let pc = 0;
  let bp = 0;
  let sp = proto.nlocals;

  const num = (i: number) => stack[i] as number;

  for (;;) {
    const at = pc;
    const op = code[pc++];
    try {
      switch (op) {
        case Op.CONST: stack[sp++] = m.consts[code[pc++]]; break;
        case Op.POP: sp--; break;
        case Op.DUP: stack[sp] = stack[sp - 1]; sp++; break;

        case Op.LOADL: stack[sp++] = stack[bp + code[pc++]]; break;
        case Op.STOREL: stack[bp + code[pc++]] = stack[--sp]; break;
        case Op.LOADG: stack[sp++] = globals[code[pc++]]; break;
        case Op.STOREG: globals[code[pc++]] = stack[--sp]; break;

        case Op.ADD: sp--; stack[sp - 1] = checkInt(num(sp - 1) + num(sp)); break;
        case Op.SUB: sp--; stack[sp - 1] = checkInt(num(sp - 1) - num(sp)); break;
        case Op.MUL: sp--; stack[sp - 1] = checkInt(num(sp - 1) * num(sp)); break;
        case Op.DIV: sp--; stack[sp - 1] = intDiv(num(sp - 1), num(sp)); break;
        case Op.MOD: sp--; stack[sp - 1] = intMod(num(sp - 1), num(sp)); break;
        case Op.NEG: stack[sp - 1] = -num(sp - 1); break;

        case Op.FADD: sp--; stack[sp - 1] = num(sp - 1) + num(sp); break;
        case Op.FSUB: sp--; stack[sp - 1] = num(sp - 1) - num(sp); break;
        case Op.FMUL: sp--; stack[sp - 1] = num(sp - 1) * num(sp); break;
        case Op.FDIV: sp--; stack[sp - 1] = num(sp - 1) / num(sp); break;

        case Op.CAT: sp--; stack[sp - 1] = (stack[sp - 1] as string) + (stack[sp] as string); break;

        case Op.EQ: sp--; stack[sp - 1] = stack[sp - 1] === stack[sp]; break;
        case Op.NE: sp--; stack[sp - 1] = stack[sp - 1] !== stack[sp]; break;
        case Op.LT: sp--; stack[sp - 1] = num(sp - 1) < num(sp); break;
        case Op.LE: sp--; stack[sp - 1] = num(sp - 1) <= num(sp); break;
        case Op.GT: sp--; stack[sp - 1] = num(sp - 1) > num(sp); break;
        case Op.GE: sp--; stack[sp - 1] = num(sp - 1) >= num(sp); break;
        case Op.NOT: stack[sp - 1] = !stack[sp - 1]; break;

        case Op.JMP: pc = code[pc]; break;
        case Op.JMPF: if (!stack[--sp]) pc = code[pc]; else pc++; break;

        case Op.CALL: {
          const callee = m.fns[code[pc++]];
          if (frames.length >= MAX_DEPTH || sp + callee.nlocals >= STACK_SIZE) {
            throw new RuntimeError('stack overflow');
          }
          frames.push({ proto, pc, bp });
          bp = sp - callee.arity;
          for (let i = callee.arity; i < callee.nlocals; i++) stack[bp + i] = null;
          sp = bp + callee.nlocals;
          proto = callee;
          code = callee.code;
          pc = 0;
          break;
        }

        case Op.RET:
        case Op.RETV: {
          const v = op === Op.RET ? stack[sp - 1] : null;
          sp = bp;
          const f = frames.pop()!;
          proto = f.proto;
          code = proto.code;
          pc = f.pc;
          bp = f.bp;
          if (op === Op.RET) stack[sp++] = v;
          break;
        }

        case Op.PRINT: io.out(format(stack[--sp], TYPE_TAGS[code[pc++]]) + '\n'); break;
        case Op.STR: stack[sp - 1] = format(stack[sp - 1], TYPE_TAGS[code[pc++]]); break;
        case Op.F2I: stack[sp - 1] = floatToInt(num(sp - 1)); break;
        case Op.LEN: {
          const v = stack[sp - 1];
          stack[sp - 1] = Array.isArray(v) ? v.length : Buffer.byteLength(v as string);
          break;
        }

        case Op.NEWARR: {
          const n = code[pc++];
          sp -= n;
          stack[sp] = stack.slice(sp, sp + n);
          sp++;
          break;
        }
        case Op.INDEX: {
          sp--;
          const arr = stack[sp - 1] as Value[];
          stack[sp - 1] = arr[checkIndex(arr, num(sp))];
          break;
        }
        case Op.SETINDEX: {
          sp -= 3;
          const arr = stack[sp] as Value[];
          arr[checkIndex(arr, num(sp + 1))] = stack[sp + 2];
          break;
        }
        case Op.PUSHA: sp -= 2; (stack[sp] as Value[]).push(stack[sp + 1]); break;
        case Op.POPA: {
          const arr = stack[sp - 1] as Value[];
          if (arr.length === 0) throw new RuntimeError('pop from empty array');
          stack[sp - 1] = arr.pop()!;
          break;
        }

        case Op.HALT: return;

        default:
          throw new Error(`bad opcode ${op} at ${at}`);
      }
    } catch (e) {
      if (e instanceof RuntimeError && !e.span) e.span = proto.spans[at];
      throw e;
    }
  }
}
