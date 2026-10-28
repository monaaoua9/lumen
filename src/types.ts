export type Scalar = 'int' | 'float' | 'bool' | 'string';
export type StructType = `@${string}`; // user types carry their name after '@'
export type Elem = Scalar | StructType;
export type ArrayType = `${Elem}[]`;
export type Type = Elem | ArrayType | 'void' | 'error';

export const isArray = (t: Type): t is ArrayType => t.endsWith('[]');
export const isStruct = (t: Type): t is StructType => t.startsWith('@') && !t.endsWith('[]');
export const elemOf = (t: ArrayType): Elem => t.slice(0, -2) as Elem;
export const arrayOf = (t: Elem): ArrayType => `${t}[]` as ArrayType;
export const structType = (name: string): StructType => `@${name}`;
export const structName = (t: StructType): string => t.slice(1);
// arrays and structs are shared references
export const isRef = (t: Type) => isArray(t) || isStruct(t);

const NAMED: Record<string, Type> = { int: 'int', float: 'float', bool: 'bool', string: 'string' };

export function typeFromName(name: string): Type | null {
  return NAMED[name] ?? null;
}

export type BuiltinName = 'print' | 'str' | 'int' | 'float' | 'len' | 'push' | 'pop';

// arity only, argument types are checked in the analyzer because several builtins are generic over arrays
export const BUILTINS: Record<BuiltinName, { arity: number }> = {
  print: { arity: 1 },
  str: { arity: 1 },
  int: { arity: 1 },
  float: { arity: 1 },
  len: { arity: 1 },
  push: { arity: 2 },
  pop: { arity: 1 },
};

export function isBuiltin(name: string): name is BuiltinName {
  return Object.hasOwn(BUILTINS, name);
}

export const isNumeric = (t: Type) => t === 'int' || t === 'float';
