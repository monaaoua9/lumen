import type { Span } from './diagnostics.ts';
import type { Type } from './types.ts';
import type { EnumInfo, StructInfo, Value } from './runtime.ts';

// [name, operand count]
const TABLE = [
  ['CONST', 1], ['POP', 0], ['DUP', 0],
  ['LOADL', 1], ['STOREL', 1], ['LOADG', 1], ['STOREG', 1],
  ['ADD', 0], ['SUB', 0], ['MUL', 0], ['DIV', 0], ['MOD', 0], ['NEG', 0],
  ['FADD', 0], ['FSUB', 0], ['FMUL', 0], ['FDIV', 0],
  ['CAT', 0],
  ['EQ', 0], ['NE', 0], ['LT', 0], ['LE', 0], ['GT', 0], ['GE', 0], ['NOT', 0],
  ['JMP', 1], ['JMPF', 1],
  ['JFLT', 1], ['JFLE', 1], ['JFGT', 1], ['JFGE', 1], ['JFEQ', 1], ['JFNE', 1],
  ['CALL', 1], ['CALLI', 0], ['RET', 0], ['RETV', 0],
  ['PRINT', 1], ['STR', 1], ['F2I', 0], ['LEN', 0],
  ['NEWARR', 1], ['REORDER', 1], ['GETF', 1], ['SETF', 1], ['INDEX', 0], ['SETINDEX', 0], ['PUSHA', 0], ['POPA', 0],
  ['HALT', 0],
] as const;

type OpName = (typeof TABLE)[number][0];

export const Op = Object.fromEntries(TABLE.map(([n], i) => [n, i])) as Record<OpName, number>;
export const OP_NAMES: string[] = TABLE.map(([n]) => n);
export const OP_ARGS: number[] = TABLE.map(([, n]) => n);

export interface Proto {
  name: string;
  arity: number;
  nlocals: number;
  returns: boolean; // does CALL leave a value behind
  code: number[];
  spans: (Span | undefined)[]; // indexed by opcode position
}

export interface Module {
  consts: Value[];
  types: Type[]; // operand of PRINT / STR indexes into this
  structs: StructInfo[];
  enums: EnumInfo[];
  fns: Proto[];
  main: Proto;
  nglobals: number;
}

export function disassemble(m: Module): string {
  const out: string[] = [];
  const dump = (p: Proto) => {
    out.push(`fn ${p.name}  (arity=${p.arity}, locals=${p.nlocals})`);
    for (let pc = 0; pc < p.code.length; ) {
      const op = p.code[pc];
      const n = OP_ARGS[op];
      const args = p.code.slice(pc + 1, pc + 1 + n);
      let note = '';
      if (op === Op.CONST) note = `   ; ${JSON.stringify(m.consts[args[0]])}`;
      else if (op === Op.CALL) note = `   ; ${m.fns[args[0]].name}`;
      else if (op === Op.PRINT || op === Op.STR) note = `   ; ${m.types[args[0]]}`;
      out.push(`  ${String(pc).padStart(4, '0')}  ${OP_NAMES[op].padEnd(8)} ${args.join(' ')}${note}`);
      pc += 1 + n;
    }
    out.push('');
  };
  dump(m.main);
  m.fns.forEach(dump);
  return out.join('\n');
}
