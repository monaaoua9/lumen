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
  origin?: VarSym; // for a closure's copy of a captured var, the one it was captured from
  box?: Type; // set when a closure captures this var: it lives in a one-element array and `box` is the value type
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
  | (Base & { k: 'var'; name: string; sym?: VarSym; raw?: boolean })
  | (Base & { k: 'lambda'; fn: FnDecl; caps: Expr[] })
  | (Base & { k: 'fnref'; name: string; fn?: FnSym })
  | (Base & { k: 'unary'; op: '-' | '!'; arg: Expr })
  | (Base & { k: 'binary'; op: BinOp; l: Expr; r: Expr })
  | (Base & { k: 'array'; elems: Expr[] })
  | (Base & { k: 'index'; arr: Expr; idx: Expr })
  | (Base & { k: 'matchx'; scrut: Expr; arms: { pats: Pat[]; value: Expr; span: Span }[]; tmp: number })
  | (Base & { k: 'enumval'; enumName: string; variant: string; idx: number; boxed: boolean })
  | (Base & { k: 'enumctor'; enumName: string; variant: string; idx: number; args: Expr[] })
  | (Base & { k: 'mcall'; obj: Expr; name: string; nameSpan: Span; args: Expr[] })
  | (Base & { k: 'field'; obj: Expr; name: string; nameSpan: Span; idx: number })
  | (Base & { k: 'structlit'; name: string; nameSpan: Span; fields: FieldInit[] })
  | (Base & { k: 'call'; name: string; nameSpan: Span; args: Expr[]; fn?: FnSym; builtin?: BuiltinName; callee?: Expr });

export interface FieldInit {
  name: string;
  nameSpan: Span;
  value: Expr;
  idx: number; // position in the declaration, filled by the analyzer
}

export interface StructField {
  name: string;
  ty: Type;
  span: Span;
}

export interface StructDecl {
  k: 'struct';
  pub?: boolean;
  span: Span;
  name: string;
  nameSpan: Span;
  fields: StructField[];
  typeParams?: string[];
  shown?: string; // what to print for an instance of a generic struct
}

export interface EnumDecl {
  k: 'enum';
  pub?: boolean;
  span: Span;
  name: string;
  nameSpan: Span;
  variants: { name: string; span: Span; payload: Type[] }[];
  typeParams?: string[];
}

export type Pat =
  | { k: 'wild'; span: Span }
  | { k: 'variant'; span: Span; name: string; idx: number; binds: ({ name: string; span: Span; sym?: VarSym } | null)[] | null; tys: Type[]; boxed: boolean }
  | { k: 'lit'; span: Span; value: number | string | boolean; ty: Type };

export interface MatchArm {
  pats: Pat[];
  body: Stmt[];
  span: Span;
}

export interface Param {
  name: string;
  ty: Type;
  span: Span;
  sym?: VarSym;
  box?: Type; // closure capture of a boxed var
  from?: VarSym;
  mutable?: boolean;
}

export interface FnDecl {
  k: 'fn';
  pub?: boolean;
  span: Span;
  name: string;
  nameSpan: Span;
  params: Param[];
  ret: Type;
  body: Stmt[];
  sym?: FnSym;
  nlocals: number;
  typeParams?: string[];
  bounds?: Record<string, string[]>; // T: Shape + Other
}

export type Stmt =
  | { k: 'let'; span: Span; name: string; nameSpan: Span; mutable: boolean; annot?: Type; annotSpan?: Span; init: Expr; sym?: VarSym }
  | { k: 'assign'; span: Span; name: string; nameSpan: Span; value: Expr; sym?: VarSym }
  | { k: 'match'; span: Span; scrut: Expr; arms: MatchArm[]; tmp: number }
  | { k: 'setfield'; span: Span; obj: Expr; name: string; nameSpan: Span; idx: number; value: Expr }
  | { k: 'setindex'; span: Span; arr: Expr; idx: Expr; value: Expr }
  | { k: 'expr'; span: Span; e: Expr }
  | { k: 'if'; span: Span; cond: Expr; then: Stmt[]; els: Stmt[] | null }
  | { k: 'while'; span: Span; cond: Expr; body: Stmt[] }
  | { k: 'return'; span: Span; value?: Expr }
  | { k: 'break'; span: Span }
  | { k: 'continue'; span: Span }
  | { k: 'block'; span: Span; body: Stmt[] }
  | StructDecl
  | EnumDecl
  | FnDecl;

export interface TraitDecl {
  name: string;
  pub?: boolean;
  nameSpan: Span;
  methods: { name: string; span: Span; hasSelf: boolean; params: Param[]; ret: Type; body?: Stmt[] }[];
}

export interface ImplFor {
  trait: string;
  type: string;
  span: Span;
}

export interface Qualified {
  module: string;
  name: string;
  span: Span;
}

export interface Program {
  qualified: Qualified[];
  traits: TraitDecl[];
  impls: ImplFor[];
  body: Stmt[];
  fns: FnDecl[];
  structs: StructDecl[];
  enums: EnumDecl[];
  nlocals: number;
  nglobals: number;
}
