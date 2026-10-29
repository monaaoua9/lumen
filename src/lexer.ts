import type { Diagnostic, Span } from './diagnostics.ts';

export interface Token {
  kind: string; // 'int' | 'float' | 'string' | 'ident' | 'eof' | the keyword/punct text itself
  text: string;
  span: Span;
  value?: number | string;
}

const KEYWORDS = new Set(['fn', 'let', 'var', 'if', 'else', 'while', 'for', 'in', 'impl', 'trait', 'pub', 'struct', 'enum', 'match', 'return', 'break', 'continue', 'true', 'false']);

const TWO = new Set(['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '=>', '..']);
const ONE = new Set('+-*/%(){}[],;:=<>!.|'.split(''));

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
    if (c === '/' && src[i + 1] === '*') {
      const open = i;
      const end = src.indexOf('*/', i + 2);
      if (end < 0) {
        err('L005', 'unterminated block comment', open, open + 2);
        i = src.length;
      } else {
        i = end + 2;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    const start = i;

    if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'b')) {
      const radix = src[i + 1] === 'x' ? 16 : 2;
      const ok = (ch: string) => ch === '_' || (radix === 16 ? /[0-9a-fA-F]/.test(ch) : ch === '0' || ch === '1');
      i += 2;
      const digits = i;
      while (i < src.length && ok(src[i])) i++;
      const body = src.slice(digits, i).replace(/_/g, '');
      if (body === '') {
        err('L003', radix === 16 ? 'hex literal has no digits' : 'binary literal has no digits', start, i);
      }
      const value = parseInt(body || '0', radix);
      if (!Number.isSafeInteger(value)) err('L003', 'integer literal is too large', start, i);
      tokens.push({ kind: 'int', text: src.slice(start, i), span: { start, end: i }, value });
      continue;
    }

    if (isDigit(c)) {
      while (isDigit(src[i] ?? '') || (src[i] === '_' && isDigit(src[i + 1] ?? ''))) i++;
      let isFloat = false;
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        isFloat = true;
        i++;
        while (isDigit(src[i] ?? '') || (src[i] === '_' && isDigit(src[i + 1] ?? ''))) i++;
      }
      // 1e9, 2.5e-5: an exponent makes it a float
      if ((src[i] === 'e' || src[i] === 'E') && (isDigit(src[i + 1] ?? '') || ((src[i + 1] === '+' || src[i + 1] === '-') && isDigit(src[i + 2] ?? '')))) {
        isFloat = true;
        i += 2;
        while (isDigit(src[i] ?? '')) i++;
      }
      const text = src.slice(start, i);
      const value = Number(text.replace(/_/g, ''));
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
      // "a{x}b" lexes as ("a" + str(x) + "b"); each hole is a literal token followed by its tokens
      const holes: { lit: string; toks: Token[] }[] = [];
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
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '0': '\0', '{': '{', '}': '}' };
          // \u{1F600} and \x41 (ASCII only, a lone high byte would not be valid UTF-8)
          const wide = nx === 'u' && src[i + 2] === '{' ? /^([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 3, i + 10)) : null;
          const code = wide ? parseInt(wide[1], 16) : -1;
          const narrow = nx === 'x' ? /^[0-7][0-9a-fA-F]/.exec(src.slice(i + 2, i + 4)) : null;
          if (wide && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
            val += String.fromCodePoint(code);
            i += 4 + wide[1].length;
            continue;
          }
          if (narrow) {
            val += String.fromCharCode(parseInt(narrow[0], 16));
            i += 4;
            continue;
          }
          if (nx !== undefined && nx in map) {
            val += map[nx];
          } else {
            err('L002', `unknown escape sequence '\\${nx ?? ''}'`, i, i + 2);
          }
          i += 2;
          continue;
        }
        if (ch === '{') {
          // find the matching brace; strings inside the expression are skipped over
          let depth = 1;
          let j = i + 1;
          while (j < src.length && src[j] !== '\n' && depth > 0) {
            if (src[j] === '"') {
              j++;
              while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
            } else if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          if (depth > 0 || src.slice(i + 1, j - 1).trim() === '') {
            err('L004', depth > 0 ? 'unterminated interpolation' : 'empty interpolation', i, j);
            i = j;
            continue;
          }
          const inner = lex(src.slice(i + 1, j - 1));
          const shift = i + 1;
          for (const d of inner.diags) diags.push({ ...d, span: { start: d.span.start + shift, end: d.span.end + shift } });
          const toks = inner.tokens.slice(0, -1).map(t => ({ ...t, span: { start: t.span.start + shift, end: t.span.end + shift } }));
          holes.push({ lit: val, toks });
          val = '';
          i = j;
          continue;
        }
        val += ch;
        i++;
      }
      if (!closed) err('L001', 'unterminated string literal', start, i);
      if (holes.length === 0) {
        tokens.push({ kind: 'string', text: src.slice(start, i), span: { start, end: i }, value: val });
        continue;
      }
      const sp = { start, end: i };
      const punct = (k: string): Token => ({ kind: k, text: k, span: sp });
      const lit = (v: string): Token => ({ kind: 'string', text: '', span: sp, value: v });
      tokens.push(punct('('));
      holes.forEach((h, n) => {
        // the first literal stays even when empty so the sum starts out as a string
        if (n === 0) tokens.push(lit(h.lit));
        else if (h.lit !== '') tokens.push(punct('+'), lit(h.lit));
        tokens.push(punct('+'), { kind: 'ident', text: 'str', span: sp }, punct('('), ...h.toks, punct(')'));
      });
      if (val !== '') tokens.push(punct('+'), lit(val));
      tokens.push(punct(')'));
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
