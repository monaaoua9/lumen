export type Type = 'int' | 'float' | 'bool' | 'string' | 'void' | 'error';

const NAMED: Record<string, Type> = { int: 'int', float: 'float', bool: 'bool', string: 'string' };

export function typeFromName(name: string): Type | null {
  return NAMED[name] ?? null;
}

export type BuiltinName = 'print' | 'str' | 'int' | 'float' | 'len';

export interface BuiltinSig {
  name: BuiltinName;
  accepts: Type[];
  ret: Type;
}

const ANY: Type[] = ['int', 'float', 'bool', 'string'];

export const BUILTINS: Record<BuiltinName, BuiltinSig> = {
  print: { name: 'print', accepts: ANY, ret: 'void' },
  str: { name: 'str', accepts: ANY, ret: 'string' },
  int: { name: 'int', accepts: ['int', 'float'], ret: 'int' },
  float: { name: 'float', accepts: ['int', 'float'], ret: 'float' },
  len: { name: 'len', accepts: ['string'], ret: 'int' },
};

export function isBuiltin(name: string): name is BuiltinName {
  return Object.hasOwn(BUILTINS, name);
}

export const isNumeric = (t: Type) => t === 'int' || t === 'float';
