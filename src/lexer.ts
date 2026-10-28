import type { Diagnostic, Span } from './diagnostics.ts';

export interface Token {
  kind: string; // 'int' | 'float' | 'string' | 'ident' | 'eof' | the keyword/punct text itself
  text: string;
  span: Span;
  value?: number | string;
}

const KEYWORDS = new Set(['fn', 'let', 'var', 'if', 'else', 'while', 'struct', 'return', 'break', 'continue', 'true', 'false']);

const TWO = new Set(['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=']);
const ONE = new Set('+-*/%(){}[],;:=<>!.'.split(''));

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';

export function lex(src: string): { tokens: Token[]; diags: Diagnostic[] } {
  const tokens: Token[] = [];
  const diags: Diagnostic[] = [];
  const err = (code: string, message: string, start: number, end: number) =>
    diags.push({ severity: 'error', code, message, span: { start, end } });

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    const start = i;

    if (isDigit(c)) {
      while (isDigit(src[i] ?? '')) i++;
      let isFloat = false;
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        isFloat = true;
        i++;
        while (isDigit(src[i] ?? '')) i++;
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!isFloat && !Number.isSafeInteger(value)) {
        err('L003', 'integer literal is too large', start, i);
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', text, span: { start, end: i }, value });
      continue;
    }

    if (isIdStart(c)) {
      while (i < src.length && (isIdStart(src[i]) || isDigit(src[i]))) i++;
      const text = src.slice(start, i);
      tokens.push({ kind: KEYWORDS.has(text) ? text : 'ident', text, span: { start, end: i } });
      continue;
    }

    if (c === '"') {
      i++;
      let val = '';
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        if (ch === '\n') break;
        if (ch === '\\') {
          const nx = src[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '0': '\0' };
          if (nx !== undefined && nx in map) {
            val += map[nx];
          } else {
            err('L002', `unknown escape sequence '\\${nx ?? ''}'`, i, i + 2);
          }
          i += 2;
          continue;
        }
        val += ch;
        i++;
      }
      if (!closed) err('L001', 'unterminated string literal', start, i);
      tokens.push({ kind: 'string', text: src.slice(start, i), span: { start, end: i }, value: val });
      continue;
    }

    const two = src.slice(i, i + 2);
    if (TWO.has(two)) {
      tokens.push({ kind: two, text: two, span: { start, end: i + 2 } });
      i += 2;
      continue;
    }
    if (ONE.has(c)) {
      tokens.push({ kind: c, text: c, span: { start, end: i + 1 } });
      i++;
      continue;
    }

    err('L000', `unexpected character '${c}'`, i, i + 1);
    i++;
  }

  tokens.push({ kind: 'eof', text: '', span: { start: src.length, end: src.length } });
  return { tokens, diags };
}
