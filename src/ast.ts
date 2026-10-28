import type { Span } from './diagnostics.ts';
import type { BuiltinName, Type } from './types.ts';

export interface VarSym {
  name: string;
  ty: Type;
  mutable: boolean;
  where: 'global' | 'local';
  slot: number;
  span: Span;
  isParam: boolean;
  used: boolean;
  assigned: boolean;
}

export interface FnSym {
  name: string;
  params: Type[];
  ret: Type;
  index: number;
  span: Span;
  used: boolean;
  decl: FnDecl;
}

interface Base {
  span: Span;
  ty: Type;
}

export type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';

export type Expr =
  | (Base & { k: 'int'; value: number })
  | (Base & { k: 'float'; value: number })
  | (Base & { k: 'str'; value: string })
  | (Base & { k: 'bool'; value: boolean })
  | (Base & { k: 'var'; name: string; sym?: VarSym })
  | (Base & { k: 'unary'; op: '-' | '!'; arg: Expr })
  | (Base & { k: 'binary'; op: BinOp; l: Expr; r: Expr })
  | (Base & { k: 'call'; name: string; nameSpan: Span; args: Expr[]; fn?: FnSym; builtin?: BuiltinName });

export interface Param {
  name: string;
  ty: Type;
  span: Span;
  sym?: VarSym;
}

export interface FnDecl {
  k: 'fn';
  span: Span;
  name: string;
  nameSpan: Span;
  params: Param[];
  ret: Type;
  body: Stmt[];
  sym?: FnSym;
  nlocals: number;
}

export type Stmt =
  | { k: 'let'; span: Span; name: string; nameSpan: Span; mutable: boolean; annot?: Type; annotSpan?: Span; init: Expr; sym?: VarSym }
  | { k: 'assign'; span: Span; name: string; nameSpan: Span; value: Expr; sym?: VarSym }
  | { k: 'expr'; span: Span; e: Expr }
  | { k: 'if'; span: Span; cond: Expr; then: Stmt[]; els: Stmt[] | null }
  | { k: 'while'; span: Span; cond: Expr; body: Stmt[] }
  | { k: 'return'; span: Span; value?: Expr }
  | { k: 'break'; span: Span }
  | { k: 'continue'; span: Span }
  | { k: 'block'; span: Span; body: Stmt[] }
  | FnDecl;

export interface Program {
  body: Stmt[];
  fns: FnDecl[];
  nlocals: number;
  nglobals: number;
}
