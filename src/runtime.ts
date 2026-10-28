import { readFileSync } from 'node:fs';
import { ExitSignal, RuntimeError } from './diagnostics.ts';
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

export interface StructInfo {
  name: string;
  shown?: string;
  fields: { name: string; ty: Type }[];
}

export interface EnumInfo {
  name: string;
  variants: { name: string; payload: Type[] }[];
}

const enumLayouts = new Map<string, EnumInfo>();

// struct layouts, needed to print a struct from a bare value array. set once per run
const layouts = new Map<string, StructInfo>();

export function registerTypes(structs: StructInfo[], enums: EnumInfo[]) {
  layouts.clear();
  enumLayouts.clear();
  for (const s of structs) layouts.set(s.name, s);
  for (const e of enums) enumLayouts.set(e.name, e);
}

// inside containers strings are quoted so ["a", "b"] differs from [a, b]
function formatInner(v: Value, ty: Type): string {
  return ty === 'string' ? `"${v}"` : format(v, ty);
}

export function format(v: Value, ty: Type): string {
  switch (ty) {
    case 'float': return formatFloat(v as number);
    case 'int': return String(v);
    case 'bool': return v ? 'true' : 'false';
    case 'string': return v as string;
  }
  if (ty.startsWith('<') && ty.endsWith('>')) return '<fn>';
  if (ty.startsWith('#') && !ty.endsWith('[]')) {
    const info = enumLayouts.get(ty.slice(1))!;
    if (!info.variants.some(x => x.payload.length > 0)) return info.variants[v as number].name;
    // enums with data are [tag, ...values]
    const vals = v as Value[];
    const variant = info.variants[vals[0] as number];
    if (variant.payload.length === 0) return variant.name;
    return `${variant.name}(${variant.payload.map((t, j) => formatInner(vals[j + 1], t)).join(', ')})`;
  }
  if (ty.endsWith('[]')) {
    const et = ty.slice(0, -2) as Type;
    return '[' + (v as Value[]).map(x => formatInner(x, et)).join(', ') + ']';
  }
  const info = layouts.get(ty.slice(1))!;
  const vals = v as Value[];
  return `${info.shown ?? info.name} { ${info.fields.map((f, i) => `${f.name}: ${formatInner(vals[i], f.ty)}`).join(', ')} }`;
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
    case 'sqrt': return sqrtOf(a as number, span);
    case 'substr': return substrOf(a as string, args[1] as number, args[2] as number, span);
    case 'find': return Buffer.from(a as string).indexOf(Buffer.from(args[1] as string));
    case 'byte': return byteAt(a as string, args[1] as number, span);
    case 'join': return (a as unknown as string[]).join(args[1] as string);
    case 'trim': return trimOf(a as string);
    case 'assert': if (!a) throw new RuntimeError('assertion failed: ' + (args[1] as string), span); return null;
    case 'read_line': return readLine();
    case 'at_eof': return atEof();
    case 'sort': sortArr(a as Value[]); return null;
    case 'reverse': (a as Value[]).reverse(); return null;
    case 'contains': return (a as Value[]).includes(args[1]);
    case 'slice': return sliceOf(a as Value[], args[1] as number, args[2] as number, span);
    case 'floor': return Math.floor(a as number);
    case 'ceil': return Math.ceil(a as number);
    case 'exit': throw exitWith(a as number, span);
    case 'chr': return chrOf(a as number, span);
    case 'split': return splitOf(a as string, args[1] as string, span);
    case 'abs': return Math.abs(a as number);
    case 'min': return (args[1] as number) < (a as number) ? args[1] : a;
    case 'max': return (args[1] as number) > (a as number) ? args[1] : a;
    case 'parse_int': return parseIntOr(a as string, args[1] as number);
    case 'parse_float': return parseFloatOr(a as string, args[1] as number);
    case 'upper': return upperOf(a as string);
    case 'lower': return lowerOf(a as string);
    case 'replace': return replaceOf(a as string, args[1] as string, args[2] as string, span);
    case 'starts_with': return (a as string).startsWith(args[1] as string);
    case 'ends_with': return (a as string).endsWith(args[1] as string);
    case 'repeat': return repeatOf(a as string, args[1] as number, span);
    case 'insert': {
      const arr = a as Value[];
      const at = args[1] as number;
      if (at < 0 || at > arr.length) throw new RuntimeError('insert index out of bounds', span);
      arr.splice(at, 0, args[2]);
      return null;
    }
    case 'remove': return (a as Value[]).splice(checkIndex(a as Value[], args[1] as number, span), 1)[0];
    case 'pop': {
      const arr = a as Value[];
      if (arr.length === 0) throw new RuntimeError('pop from empty array', span);
      return arr.pop()!;
    }
  }
}

// strings are UTF-8 and offsets count bytes, cutting through a multi-byte character is an error
export function substrOf(s: string, start: number, n: number, span?: Span): string {
  const buf = Buffer.from(s);
  if (start < 0 || n < 0 || start + n > buf.length) throw new RuntimeError('substring out of range', span);
  const inside = (i: number) => i < buf.length && (buf[i] & 0xc0) === 0x80;
  if (inside(start) || inside(start + n)) throw new RuntimeError('substring splits a character', span);
  return buf.toString('utf8', start, start + n);
}

// utf-8 byte order, same as strcmp on the C side (js `<` would compare utf-16 units)
export function cmpStr(a: string, b: string): number {
  return a === b ? 0 : Buffer.compare(Buffer.from(a), Buffer.from(b));
}

// stdin is read once, on first use, and handed out a line at a time
let pending: string[] | null = null;
function stdinLines(): string[] {
  if (!pending) {
    let text = '';
    try { text = readFileSync(0, 'utf8'); } catch { /* no stdin attached */ }
    pending = text.split('\n');
    if (pending[pending.length - 1] === '') pending.pop();
    pending = pending.map(l => l.replace(/\r$/, '')).reverse();
  }
  return pending;
}

// plain decimal text only, anything else (spaces, hex, 1e5 for ints, overflow) gives the fallback
export function parseIntOr(s: string, fallback: number): number {
  if (!/^[+-]?[0-9]+$/.test(s)) return fallback;
  const v = Number(s);
  return Number.isSafeInteger(v) ? v : fallback;
}

export function parseFloatOr(s: string, fallback: number): number {
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(s)) return fallback;
  const v = Number(s);
  return Number.isFinite(v) ? v : fallback;
}

// ascii only, other letters pass through untouched
export const upperOf = (s: string) => s.replace(/[a-z]+/g, m => m.toUpperCase());
export const lowerOf = (s: string) => s.replace(/[A-Z]+/g, m => m.toLowerCase());

export function replaceOf(s: string, from: string, to: string, span?: Span): string {
  if (from === '') throw new RuntimeError('replace of an empty string', span);
  return s.split(from).join(to);
}

export function repeatOf(s: string, n: number, span?: Span): string {
  if (n < 0) throw new RuntimeError('repeat count is negative', span);
  return s.repeat(n);
}

export function sortArr(a: Value[]) {
  if (typeof a[0] === 'string') a.sort((x, y) => cmpStr(x as string, y as string));
  else a.sort((x, y) => (x as number) - (y as number));
}

export function sliceOf(a: Value[], start: number, n: number, span?: Span): Value[] {
  if (start < 0 || n < 0 || start + n > a.length) throw new RuntimeError('slice out of range', span);
  return a.slice(start, start + n);
}

export function exitWith(code: number, span?: Span): Error {
  return code < 0 || code > 255 ? new RuntimeError('exit code must be 0..255', span) : new ExitSignal(code);
}

export function atEof(): boolean {
  return stdinLines().length === 0;
}

export function readLine(): string {
  return stdinLines().pop() ?? '';
}

// ascii whitespace only, like the C side
export function trimOf(s: string): string {
  return s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
}

export function byteAt(s: string, i: number, span?: Span): number {
  const buf = Buffer.from(s);
  if (i < 0 || i >= buf.length) throw new RuntimeError('byte index out of range', span);
  return buf[i];
}

// ascii only, anything else would depend on an encoding
export function chrOf(n: number, span?: Span): string {
  if (n < 1 || n > 127) throw new RuntimeError('chr expects 1..127', span);
  return String.fromCharCode(n);
}

export function splitOf(s: string, sep: string, span?: Span): string[] {
  if (sep === '') throw new RuntimeError('split with an empty separator', span);
  return s.split(sep);
}

export function sqrtOf(x: number, span?: Span): number {
  if (x < 0) throw new RuntimeError('sqrt of a negative number', span);
  return Math.sqrt(x);
}

export function checkIndex(arr: Value[], i: number, span?: Span): number {
  if (i < 0 || i >= arr.length) throw new RuntimeError('index out of bounds', span);
  return i;
}
