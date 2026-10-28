export type Scalar = 'int' | 'float' | 'bool' | 'string';
export type StructType = `@${string}`; // user types carry their name after '@'
export type EnumType = `#${string}`; // enum values are ordinals at runtime
export type ArrayType = `${string}[]`;
export type FnType = `<${string}>`; // <fn(int,int):int>, the angle brackets keep it apart from arrays
export type Elem = Scalar | StructType | EnumType | ArrayType | FnType;
export type Type = Elem | 'void' | 'error';

export const isArray = (t: Type): t is ArrayType => t.endsWith('[]');
export const isStruct = (t: Type): t is StructType => t.startsWith('@') && !t.endsWith('[]');
export const isEnum = (t: Type): t is EnumType => t.startsWith('#') && !t.endsWith('[]');
export const isFn = (t: Type): t is FnType => t.startsWith('<') && t.endsWith('>');
export const fnType = (params: Type[], ret: Type): FnType => `<fn(${params.join(',')}):${ret}>`;
export const hasFn = (t: Type) => {
  while (isArray(t)) t = elemOf(t);
  return isFn(t);
};
export function fnSig(t: FnType): { params: Type[]; ret: Type } {
  const body = t.slice(4, -1); // "int,fn..):int"
  let depth = 1;
  let close = 0;
  for (; close < body.length; close++) {
    if (body[close] === '(') depth++;
    else if (body[close] === ')' && --depth === 0) break;
  }
  const params: Type[] = [];
  let from = 0;
  depth = 0;
  for (let i = 0; i < close; i++) {
    if (body[i] === '(' || body[i] === '<') depth++;
    else if (body[i] === ')' || body[i] === '>') depth--;
    else if (body[i] === ',' && depth === 0) {
      params.push(body.slice(from, i) as Type);
      from = i + 1;
    }
  }
  if (close > from) params.push(body.slice(from, close) as Type);
  return { params, ret: body.slice(close + 2) as Type };
}
export const elemOf = (t: ArrayType): Elem => t.slice(0, -2) as Elem;
export const arrayOf = (t: Elem): ArrayType => `${t}[]` as ArrayType;
export const structType = (name: string): StructType => `@${name}`;
export const structName = (t: StructType): string => t.slice(1);
export const enumType = (name: string): EnumType => `#${name}`;
export const enumName = (t: EnumType): string => t.slice(1);
// arrays and structs are shared references
export const isRef = (t: Type) => isArray(t) || isStruct(t);

const NAMED: Record<string, Type> = { int: 'int', float: 'float', bool: 'bool', string: 'string' };

export function typeFromName(name: string): Type | null {
  return NAMED[name] ?? null;
}

export type BuiltinName = 'print' | 'str' | 'int' | 'float' | 'len' | 'push' | 'pop' | 'sqrt' | 'abs' | 'min' | 'max' | 'substr' | 'find' | 'split' | 'byte' | 'chr' | 'join' | 'trim' | 'assert' | 'read_line' | 'at_eof' | 'exit' | 'sort' | 'reverse' | 'contains' | 'slice' | 'floor' | 'ceil';

// arity only, argument types are checked in the analyzer because several builtins are generic over arrays
export const BUILTINS: Record<BuiltinName, { arity: number }> = {
  print: { arity: 1 },
  str: { arity: 1 },
  int: { arity: 1 },
  float: { arity: 1 },
  len: { arity: 1 },
  push: { arity: 2 },
  pop: { arity: 1 },
  sqrt: { arity: 1 },
  byte: { arity: 2 },
  chr: { arity: 1 },
  floor: { arity: 1 },
  ceil: { arity: 1 },
  sort: { arity: 1 },
  reverse: { arity: 1 },
  contains: { arity: 2 },
  slice: { arity: 3 },
  exit: { arity: 1 },
  read_line: { arity: 0 },
  at_eof: { arity: 0 },
  assert: { arity: 2 },
  join: { arity: 2 },
  trim: { arity: 1 },
  abs: { arity: 1 },
  min: { arity: 2 },
  max: { arity: 2 },
  substr: { arity: 3 },
  find: { arity: 2 },
  split: { arity: 2 },
};

export function isBuiltin(name: string): name is BuiltinName {
  return Object.hasOwn(BUILTINS, name);
}

export const isNumeric = (t: Type) => t === 'int' || t === 'float';
