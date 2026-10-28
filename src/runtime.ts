import { RuntimeError } from './diagnostics.ts';
import type { Span } from './diagnostics.ts';
import type { BuiltinName, Type } from './types.ts';

export type Value = number | string | boolean | null;

export const MAX_DEPTH = 1000;

export interface IO {
  out(s: string): void;
}

export function formatFloat(v: number): string {
  const s = String(v);
  if (!Number.isFinite(v) || s.includes('.') || s.includes('e')) return s;
  return s + '.0';
}

export function format(v: Value, ty: Type): string {
  switch (ty) {
    case 'float': return formatFloat(v as number);
    case 'int': return String(v);
    case 'bool': return v ? 'true' : 'false';
    default: return v as string;
  }
}

// ints are plain JS numbers but trap as soon as they leave the safe range,
// so the interpreter, the VM and the C backend agree on what an overflow is
export function checkInt(n: number, span?: Span): number {
  if (!Number.isSafeInteger(n)) throw new RuntimeError('integer overflow', span);
  return n;
}

export function intDiv(a: number, b: number, span?: Span): number {
  if (b === 0) throw new RuntimeError('division by zero', span);
  return Math.trunc(a / b);
}

export function intMod(a: number, b: number, span?: Span): number {
  if (b === 0) throw new RuntimeError('modulo by zero', span);
  return a % b;
}

export function floatToInt(v: number, span?: Span): number {
  if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) {
    throw new RuntimeError('float out of range for int', span);
  }
  return Math.trunc(v) + 0; // + 0 turns -0 into 0
}

// the one-arg builtins, arg type is known statically
export function callBuiltin(name: BuiltinName, arg: Value, argTy: Type, io: IO, span?: Span): Value {
  switch (name) {
    case 'print': io.out(format(arg, argTy) + '\n'); return null;
    case 'str': return format(arg, argTy);
    case 'int': return argTy === 'int' ? arg : floatToInt(arg as number, span);
    case 'float': return arg;
    case 'len': return Buffer.byteLength(arg as string);
  }
}
