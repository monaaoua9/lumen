import { RuntimeError } from './diagnostics.ts';
import { Op } from './bytecode.ts';
import type { Module, Proto } from './bytecode.ts';
import { MAX_DEPTH, byteAt, readLine, atEof, checkIndex, chrOf, cmpStr, checkInt, floatToInt, format, intDiv, intMod, registerTypes, splitOf, sqrtOf, substrOf, trimOf } from './runtime.ts';
import type { IO, Value } from './runtime.ts';

const STACK_SIZE = 1 << 16;

export function run(m: Module, io: IO) {
  registerTypes(m.structs, m.enums);
  const stack: Value[] = new Array(STACK_SIZE).fill(null);
  const globals: Value[] = new Array(m.nglobals).fill(null);
  // call frames as parallel arrays, no object allocation per call
  const fProto: Proto[] = new Array(MAX_DEPTH + 1);
  const fPc: number[] = new Array(MAX_DEPTH + 1).fill(0);
  const fBp: number[] = new Array(MAX_DEPTH + 1).fill(0);
  let depth = 0;
  const consts = m.consts;
  const fns = m.fns;

  let proto = m.main;
  let code = proto.code;
  let pc = 0;
  let bp = 0;
  let sp = proto.nlocals;

  const num = (i: number) => stack[i] as number;

  try {
    for (;;) {
      const op = code[pc++];
      switch (op) {
        case Op.CONST: stack[sp++] = consts[code[pc++]]; break;
        case Op.POP: sp--; break;
        case Op.DUP: stack[sp] = stack[sp - 1]; sp++; break;

        case Op.LOADL: stack[sp++] = stack[bp + code[pc++]]; break;
        case Op.STOREL: stack[bp + code[pc++]] = stack[--sp]; break;
        case Op.ADDLI: { const r = num(bp + code[pc]) + code[pc + 1]; pc += 2; if (!Number.isSafeInteger(r)) checkInt(r); stack[sp++] = r; break; }
        case Op.ADDGI: { const r = (globals[code[pc]] as number) + code[pc + 1]; pc += 2; if (!Number.isSafeInteger(r)) checkInt(r); stack[sp++] = r; break; }
        case Op.LOADG: stack[sp++] = globals[code[pc++]]; break;
        case Op.STOREG: globals[code[pc++]] = stack[--sp]; break;

        case Op.ADD: { sp--; const r = num(sp - 1) + num(sp); if (!Number.isSafeInteger(r)) checkInt(r); stack[sp - 1] = r; break; }
        case Op.SUB: { sp--; const r = num(sp - 1) - num(sp); if (!Number.isSafeInteger(r)) checkInt(r); stack[sp - 1] = r; break; }
        case Op.MUL: { sp--; const r = num(sp - 1) * num(sp); if (!Number.isSafeInteger(r)) checkInt(r); stack[sp - 1] = r; break; }
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
        case Op.JFLT: sp -= 2; if (!(num(sp) < num(sp + 1))) pc = code[pc]; else pc++; break;
        case Op.JFLE: sp -= 2; if (!(num(sp) <= num(sp + 1))) pc = code[pc]; else pc++; break;
        case Op.JFGT: sp -= 2; if (!(num(sp) > num(sp + 1))) pc = code[pc]; else pc++; break;
        case Op.JFGE: sp -= 2; if (!(num(sp) >= num(sp + 1))) pc = code[pc]; else pc++; break;
        case Op.JFEQ: sp -= 2; if (stack[sp] !== stack[sp + 1]) pc = code[pc]; else pc++; break;
        case Op.JFNE: sp -= 2; if (stack[sp] === stack[sp + 1]) pc = code[pc]; else pc++; break;

        case Op.MKCLO: {
          const idx = code[pc++];
          const n = code[pc++];
          sp -= n;
          stack[sp] = [idx, ...stack.slice(sp, sp + n)];
          sp++;
          break;
        }

        case Op.CALL:
        case Op.CALLI: {
          let callee: Proto;
          if (op === Op.CALL) {
            callee = fns[code[pc++]];
          } else {
            const fv = stack[--sp];
            if (typeof fv === 'number') {
              callee = fns[fv];
            } else {
              // closure: [fn index, ...captured values], the captures follow the arguments
              const clo = fv as Value[];
              callee = fns[clo[0] as number];
              for (let i = 1; i < clo.length; i++) stack[sp++] = clo[i];
            }
          }
          if (depth >= MAX_DEPTH || sp + callee.nlocals >= STACK_SIZE) {
            throw new RuntimeError('stack overflow');
          }
          fProto[depth] = proto;
          fPc[depth] = pc;
          fBp[depth] = bp;
          depth++;
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
          depth--;
          proto = fProto[depth];
          code = proto.code;
          pc = fPc[depth];
          bp = fBp[depth];
          if (op === Op.RET) stack[sp++] = v;
          break;
        }

        case Op.PRINT: io.out(format(stack[--sp], m.types[code[pc++]]) + '\n'); break;
        case Op.STR: stack[sp - 1] = format(stack[sp - 1], m.types[code[pc++]]); break;
        case Op.SUBSTR: sp -= 2; stack[sp - 1] = substrOf(stack[sp - 1] as string, num(sp), num(sp + 1)); break;
        case Op.FIND: sp--; stack[sp - 1] = Buffer.from(stack[sp - 1] as string).indexOf(Buffer.from(stack[sp] as string)); break;
        case Op.SPLIT: sp--; stack[sp - 1] = splitOf(stack[sp - 1] as string, stack[sp] as string); break;
        case Op.BYTE: sp--; stack[sp - 1] = byteAt(stack[sp - 1] as string, num(sp)); break;
        case Op.CHR: stack[sp - 1] = chrOf(num(sp - 1)); break;
        case Op.SCMP: sp--; stack[sp - 1] = cmpStr(stack[sp - 1] as string, stack[sp] as string); break;
        case Op.JOIN: sp--; stack[sp - 1] = (stack[sp - 1] as unknown as string[]).join(stack[sp] as string); break;
        case Op.TRIM: stack[sp - 1] = trimOf(stack[sp - 1] as string); break;
        case Op.ASSERT: sp -= 2; if (!stack[sp]) throw new RuntimeError('assertion failed: ' + (stack[sp + 1] as string)); break;
        case Op.READLN: stack[sp++] = readLine(); break;
        case Op.ATEOF: stack[sp++] = atEof(); break;
        case Op.SQRT: stack[sp - 1] = sqrtOf(num(sp - 1)); break;
        case Op.ABS: stack[sp - 1] = Math.abs(num(sp - 1)); break;
        case Op.MIN: sp--; if (num(sp) < num(sp - 1)) stack[sp - 1] = stack[sp]; break;
        case Op.MAX: sp--; if (num(sp) > num(sp - 1)) stack[sp - 1] = stack[sp]; break;
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
        case Op.REORDER: {
          const perm = m.consts[code[pc++]] as number[];
          const src = stack[sp - 1] as Value[];
          const out: Value[] = new Array(src.length);
          perm.forEach((dst, i) => { out[dst] = src[i]; });
          stack[sp - 1] = out;
          break;
        }
        case Op.GETF: stack[sp - 1] = (stack[sp - 1] as Value[])[code[pc++]]; break;
        case Op.SETF: sp -= 2; (stack[sp] as Value[])[code[pc++]] = stack[sp + 1]; break;
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
          throw new Error(`bad opcode ${op} at ${pc - 1}`);
      }
    }
  } catch (e) {
    if (e instanceof RuntimeError && !e.span) e.span = proto.spans[pc - 1];
    throw e;
  }
}
