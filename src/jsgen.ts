import { RuntimeError } from './diagnostics.ts';
import type { Span } from './diagnostics.ts';
import type { Expr, FnDecl, Pat, Program, Stmt } from './ast.ts';
import { MAX_DEPTH, bitOp, byteLen, callBuiltin, checkIndex, cmpStr, format, intDiv, intMod, registerTypes } from './runtime.ts';
import type { IO, Value } from './runtime.ts';
import type { Type } from './types.ts';

const MAXINT = 9007199254740991;

// small helpers the generated code calls; V8 inlines them in hot loops
function makeRuntime(io: IO, spans: Span[]) {
  const ovf = (s: number): never => {
    throw new RuntimeError('integer overflow', spans[s]);
  };
  return {
    add: (a: number, b: number, s: number) => {
      const r = a + b;
      return r > MAXINT || r < -MAXINT ? ovf(s) : r;
    },
    sub: (a: number, b: number, s: number) => {
      const r = a - b;
      return r > MAXINT || r < -MAXINT ? ovf(s) : r;
    },
    mul: (a: number, b: number, s: number) => {
      const r = a * b;
      return r > MAXINT || r < -MAXINT ? ovf(s) : r;
    },
    div: (a: number, b: number, s: number) => intDiv(a, b, spans[s]),
    mod: (a: number, b: number, s: number) => intMod(a, b, spans[s]),
    bit: (op: string, a: number, b: number, s: number) => bitOp(op, a, b, spans[s]),
    ix: (a: Value[], i: number, s: number) => a[checkIndex(a, i, spans[s])],
    ck: (a: Value[], i: number, s: number) => checkIndex(a, i, spans[s]),
    cmp: cmpStr,
    fmt: format,
    blen: byteLen,
    out: (s: string) => io.out(s),
    b: (name: string, args: Value[], tys: Type[], s: number) => callBuiltin(name as never, args, tys, io, spans[s]),
    so: (s: number): never => {
      throw new RuntimeError('stack overflow', spans[s]);
    },
  };
}

type Runtime = ReturnType<typeof makeRuntime>;
const HELPERS = ['add', 'sub', 'mul', 'div', 'mod', 'bit', 'ix', 'ck', 'cmp', 'fmt', 'blen', 'out', 'b', 'so'] as const;

class Gen {
  spans: Span[] = [];
  fnIds = new Map<FnDecl, number>();
  queue: FnDecl[] = [];
  out: string[] = [];
  temps = 0;
  early = false;
  inFn = false;

  span(s: Span): number {
    this.spans.push(s);
    return this.spans.length - 1;
  }

  fnName(f: FnDecl): string {
    let id = this.fnIds.get(f);
    if (id === undefined) {
      id = this.fnIds.size;
      this.fnIds.set(f, id);
      this.queue.push(f);
    }
    return `f${id}`;
  }

  tmp(): string {
    return `$t${this.temps++}`;
  }

  local(slot: number) {
    return `l${slot}`;
  }

  variable(e: Extract<Expr, { k: 'var' }>): string {
    const s = e.sym!;
    return s.where === 'global' ? `g${s.slot}` : `l${s.slot}`;
  }

  // ---- statements

  block(body: Stmt[]): string {
    return body.map(s => this.stmt(s)).join('\n');
  }

  stmt(s: Stmt): string {
    switch (s.k) {
      case 'fn': case 'struct': case 'enum':
        return '';
      case 'let':
      case 'assign': {
        const sym = s.sym!;
        const v = this.expr(s.k === 'let' ? s.init : s.value);
        return `${sym.where === 'global' ? 'g' : 'l'}${sym.slot} = ${v};`;
      }
      case 'setfield':
        return `${this.expr(s.obj)}[${s.idx}] = ${this.expr(s.value)};`;
      case 'setindex': {
        // array, index and value are all computed before the bounds check, like the other engines
        const a = this.tmp(), i = this.tmp(), v = this.tmp();
        return `${a} = ${this.expr(s.arr)}; ${i} = ${this.expr(s.idx)}; ${v} = ${this.expr(s.value)}; ${a}[$ck(${a}, ${i}, ${this.span(s.span)})] = ${v};`;
      }
      case 'expr':
        return `${this.expr(s.e)};`;
      case 'if':
        return `if (${this.expr(s.cond)}) {\n${this.block(s.then)}\n}${s.els ? ` else {\n${this.block(s.els)}\n}` : ''}`;
      case 'while':
        return `while (${this.expr(s.cond)}) {\n${this.block(s.body)}\n}`;
      case 'return': {
        const v = s.value ? this.expr(s.value) : 'null';
        if (!this.inFn) return `return;`;
        if (this.blockDepth > 0) {
          this.early = true;
          return `{ $rv = ${v}; throw $EARLY; }`;
        }
        return `{ const $r = ${v}; $d--; return $r; }`;
      }
      case 'break': return 'break;';
      case 'continue': return 'continue;';
      case 'block': return `{\n${this.block(s.body)}\n}`;
      case 'match': {
        const m = this.tmp();
        const arms = s.arms.map((arm, i) => {
          const cond = this.armCond(m, arm.pats, arm.guard);
          const head = i === 0 ? `if (${cond})` : ` else if (${cond})`;
          return `${head} {\n${this.block(arm.body)}\n}`;
        });
        return `${m} = ${this.expr(s.scrut)};\n${arms.join('')}`;
      }
    }
  }

  blockDepth = 0;

  // true when one pattern matches, the bindings are assigned on the way
  armCond(m: string, pats: Pat[], guard?: Expr): string {
    const alts: string[] = [];
    for (const p of pats) {
      if (p.k === 'wild') {
        alts.push('true');
        break;
      }
      if (p.k === 'lit') {
        alts.push(typeof p.value === 'boolean' ? (p.value ? m : `!${m}`) : `${m} === ${JSON.stringify(p.value)}`);
        continue;
      }
      let t = `${p.boxed ? `${m}[0]` : m} === ${p.idx}`;
      const binds = (p.binds ?? []).map((b, j) => (b?.sym ? `(l${b.sym.slot} = ${m}[${j + 1}])` : '')).filter(x => x);
      if (binds.length) t = `(${t} && (${binds.join(', ')}, true))`;
      alts.push(t);
    }
    let c = alts.length === 1 ? alts[0] : `(${alts.join(' || ')})`;
    if (guard) c = `(${c} && ${this.expr(guard)})`;
    return c;
  }

  // ---- expressions

  expr(e: Expr): string {
    switch (e.k) {
      case 'int': case 'float':
        return e.value < 0 || Object.is(e.value, -0) ? `(${e.value})` : String(e.value);
      case 'str': return JSON.stringify(e.value);
      case 'bool': return String(e.value);
      case 'var': return this.variable(e);
      case 'fnref': return this.fnName(e.fn!.decl);
      case 'lambda': {
        const name = this.fnName(e.fn);
        if (e.caps.length === 0) return name;
        const ncaps = e.caps.length;
        const declared = e.fn.params.length - ncaps;
        const ps = Array.from({ length: declared }, (_, i) => `a${i}`);
        const cs = Array.from({ length: ncaps }, (_, i) => `c${i}`);
        return `((${cs.join(', ')}) => (${[...ps, '$s'].join(', ')}) => ${name}(${[...ps, ...cs, '$s'].join(', ')}))(${e.caps.map(c => this.expr(c)).join(', ')})`;
      }
      case 'unary': return e.op === '!' ? `!${this.expr(e.arg)}` : `(-${this.expr(e.arg)})`;
      case 'binary': return this.binary(e);
      case 'array': return `[${e.elems.map(x => this.expr(x)).join(', ')}]`;
      case 'blockx': {
        this.blockDepth++;
        const body = this.block(e.body);
        const value = this.expr(e.value);
        this.blockDepth--;
        return `(() => {\n${body}\nreturn ${value};\n})()`;
      }
      case 'matchx': {
        const m = this.tmp();
        let chain = 'null';
        for (let i = e.arms.length - 1; i >= 0; i--) {
          const arm = e.arms[i];
          chain = `${this.armCond(m, arm.pats, arm.guard)} ? ${this.expr(arm.value)} : ${chain}`;
        }
        return `(${m} = ${this.expr(e.scrut)}, ${chain})`;
      }
      case 'enumval': return e.boxed ? `[${e.idx}]` : String(e.idx);
      case 'mcall': throw new Error('unresolved method call');
      case 'enumctor': return `[${[String(e.idx), ...e.args.map(a => this.expr(a))].join(', ')}]`;
      case 'field': return `${this.expr(e.obj)}[${e.idx}]`;
      case 'structlit': {
        const ordered = [...e.fields].sort((a, b) => a.idx - b.idx);
        const inOrder = e.fields.every((f, i) => f === ordered[i]);
        if (inOrder) return `[${e.fields.map(f => this.expr(f.value)).join(', ')}]`;
        // written in another order than declared: evaluate as written, lay out as declared
        const temps = new Map<number, string>();
        const evals = e.fields.map(f => {
          const t = this.tmp();
          temps.set(f.idx, t);
          return `${t} = ${this.expr(f.value)}`;
        });
        return `(${evals.join(', ')}, [${ordered.map(f => temps.get(f.idx)).join(', ')}])`;
      }
      case 'index': return `$ix(${this.expr(e.arr)}, ${this.expr(e.idx)}, ${this.span(e.span)})`;
      case 'call': return this.call(e);
    }
  }

  binary(e: Extract<Expr, { k: 'binary' }>): string {
    const l = this.expr(e.l);
    const r = this.expr(e.r);
    if (e.op === '&&') return `(${l} && ${r})`;
    if (e.op === '||') return `(${l} || ${r})`;
    const ty = e.l.ty;
    if (ty === 'string' && e.op !== '+' && e.op !== '==' && e.op !== '!=') return `($cmp(${l}, ${r}) ${e.op} 0)`;
    const s = this.span(e.span);
    switch (e.op) {
      case '+': return ty === 'string' ? `(${l} + ${r})` : ty === 'int' ? `$add(${l}, ${r}, ${s})` : `(${l} + ${r})`;
      case '-': return ty === 'int' ? `$sub(${l}, ${r}, ${s})` : `(${l} - ${r})`;
      case '*': return ty === 'int' ? `$mul(${l}, ${r}, ${s})` : `(${l} * ${r})`;
      case '/': return ty === 'int' ? `$div(${l}, ${r}, ${s})` : `(${l} / ${r})`;
      case '%': return `$mod(${l}, ${r}, ${s})`;
      case '&': case '|': case '^': case '<<': case '>>': return `$bit(${JSON.stringify(e.op)}, ${l}, ${r}, ${s})`;
      case '==': return `(${l} === ${r})`;
      case '!=': return `(${l} !== ${r})`;
      default: return `(${l} ${e.op} ${r})`;
    }
  }

  call(e: Extract<Expr, { k: 'call' }>): string {
    const s = this.span(e.span);
    if (e.builtin) return this.builtin(e, s);
    const args = e.args.map(a => this.expr(a));
    if (e.callee) return `(${this.expr(e.callee)})(${[...args, s].join(', ')})`;
    return `${this.fnName(e.fn!.decl)}(${[...args, s].join(', ')})`;
  }

  builtin(e: Extract<Expr, { k: 'call' }>, s: number): string {
    const a = e.args.map(x => this.expr(x));
    const t0 = e.args[0]?.ty;
    switch (e.builtin) {
      case 'print': return `$out($fmt(${a[0]}, ${JSON.stringify(t0)}) + "\\n")`;
      case 'len': return t0 === 'string' ? `$blen(${a[0]})` : `${a[0]}.length`;
      case 'push': return `${a[0]}.push(${a[1]})`;
      case 'float': return a[0];
      case 'int': return t0 === 'int' ? a[0] : `$b("int", [${a[0]}], ["float"], ${s})`;
      case 'str': return t0 === 'int' ? `String(${a[0]})` : `$fmt(${a[0]}, ${JSON.stringify(t0)})`;
    }
    return `$b(${JSON.stringify(e.builtin)}, [${a.join(', ')}], ${JSON.stringify(e.args.map(x => x.ty))}, ${s})`;
  }

  // ---- functions

  fnSource(f: FnDecl, name: string): string {
    this.temps = 0;
    this.early = false;
    this.inFn = true;
    this.blockDepth = 0;
    const body = this.block(f.body);
    const params = f.params.map((_, i) => `l${i}`);
    const locals: string[] = [];
    for (let i = params.length; i < f.nlocals; i++) locals.push(`l${i}`);
    for (let i = 0; i < this.temps; i++) locals.push(`$t${i}`);
    const decl = locals.length ? `let ${locals.join(', ')};\n` : '';
    const enter = `$cs[$d] = $s; $nm[$d] = ${this.fnIds.get(f)}; if ($d >= ${MAX_DEPTH}) $so($s); $d++;\n`;
    let inner = `${decl}${body}\n$d--;`;
    if (this.early) inner = `${decl}try {\n${body}\n} catch ($e) {\nif ($e === $EARLY) { $d--; return $rv; }\nthrow $e;\n}\n$d--;`;
    return `function ${name}(${[...params, '$s'].join(', ')}) {\n${enter}${inner}\n}`;
  }

  program(prog: Program): string {
    this.inFn = false;
    this.temps = 0;
    this.blockDepth = 0;
    const mainBody = this.block(prog.body);
    const mainLocals: string[] = [];
    for (let i = 0; i < prog.nlocals; i++) mainLocals.push(`l${i}`);
    for (let i = 0; i < this.temps; i++) mainLocals.push(`$t${i}`);
    const main = `function $main() {\n${mainLocals.length ? `let ${mainLocals.join(', ')};\n` : ''}${mainBody}\n}`;

    const fns: string[] = [];
    while (this.queue.length) {
      const f = this.queue.shift()!;
      fns.push(this.fnSource(f, `f${this.fnIds.get(f)}`));
    }
    const globals = Array.from({ length: prog.nglobals }, (_, i) => `g${i}`);
    const pre = HELPERS.map(h => `$${h} = rt.${h}`).join(', ');
    return [
      `"use strict";`,
      `const ${pre};`,
      `let $d = 0, $rv;`,
      `const $cs = [], $nm = [], $EARLY = {};`,
      globals.length ? `let ${globals.join(', ')};` : '',
      ...fns,
      main,
      `return { main: $main, depth: () => $d, cs: $cs, nm: $nm };`,
    ].join('\n');
  }
}

export function toJs(prog: Program): { source: string; spans: Span[]; names: string[] } {
  const g = new Gen();
  const source = g.program(prog);
  const names: string[] = [];
  for (const [f, id] of g.fnIds) names[id] = f.name;
  return { source, spans: g.spans, names };
}

export function runJs(prog: Program, io: IO) {
  registerTypes(
    prog.structs.map(s => ({ name: s.name, shown: s.shown, fields: s.fields.map(f => ({ name: f.name, ty: f.ty })) })),
    prog.enums.map(e => ({ name: e.name, variants: e.variants.map(v => ({ name: v.name, payload: v.payload })) })),
  );
  const { source, spans, names } = toJs(prog);
  const rt: Runtime = makeRuntime(io, spans);
  const api = new Function('rt', source)(rt) as { main(): void; depth(): number; cs: number[]; nm: number[] };
  try {
    api.main();
  } catch (err) {
    let e = err;
    if (e instanceof RangeError) e = new RuntimeError('stack overflow');
    if (e instanceof RuntimeError && !e.trace) {
      // innermost caller first, like the interpreter builds it while unwinding
      e.trace = [];
      for (let d = api.depth() - 1; d >= 0; d--) e.trace.push({ fn: d > 0 ? names[api.nm[d - 1]] : '<main>', span: spans[api.cs[d]] });
    }
    throw e;
  }
}
