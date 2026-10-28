export type Scalar = 'int' | 'float' | 'bool' | 'string';
export type ArrayType = 'int[]' | 'float[]' | 'bool[]' | 'string[]';
export type Type = Scalar | ArrayType | 'void' | 'error';

export const isArray = (t: Type): t is ArrayType => t.endsWith('[]');
export const elemOf = (t: ArrayType): Scalar => t.slice(0, -2) as Scalar;
export const arrayOf = (t: Scalar): ArrayType => `${t}[]` as ArrayType;

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
