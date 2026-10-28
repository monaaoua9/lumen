import { RuntimeError } from './diagnostics.ts';
import type { Span } from './diagnostics.ts';
import type { BuiltinName, Type } from './types.ts';

export type Value = number | string | boolean | null | Value[];

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
    case 'string': return v as string;
    default: {
      // arrays; strings are quoted inside so ["a", "b"] is distinguishable from [a, b]
      const et = ty.slice(0, -2) as Type;
      const items = (v as Value[]).map(x => (et === 'string' ? `"${x}"` : format(x, et)));
      return '[' + items.join(', ') + ']';
    }
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

export function callBuiltin(name: BuiltinName, args: Value[], tys: Type[], io: IO, span?: Span): Value {
  const a = args[0];
  switch (name) {
    case 'print': io.out(format(a, tys[0]) + '\n'); return null;
    case 'str': return format(a, tys[0]);
    case 'int': return tys[0] === 'int' ? a : floatToInt(a as number, span);
    case 'float': return a;
    case 'len': return Array.isArray(a) ? a.length : Buffer.byteLength(a as string);
    case 'push': (a as Value[]).push(args[1]); return null;
    case 'pop': {
      const arr = a as Value[];
      if (arr.length === 0) throw new RuntimeError('pop from empty array', span);
      return arr.pop()!;
    }
  }
}

export function checkIndex(arr: Value[], i: number, span?: Span): number {
  if (i < 0 || i >= arr.length) throw new RuntimeError('index out of bounds', span);
  return i;
}
