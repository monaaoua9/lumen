import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './modules.ts';
import { frontend } from './pipeline.ts';
import type { Frontend } from './pipeline.ts';
import { format } from './fmt.ts';
import type { Diagnostic } from './diagnostics.ts';
import { BUILTINS } from './types.ts';

// language server over stdio: diagnostics on every edit, and whole-document formatting
const docs = new Map<string, string>();
// last analysis per document, for hover and go-to-definition
const last = new Map<string, { fe: Frontend; base: number; name: string }>();
// the last analysis without errors: while someone is typing, the current text rarely parses
const good = new Map<string, { fe: Frontend; base: number; name: string }>();

function send(msg: object) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });

function diagnose(uri: string) {
  const text = docs.get(uri) ?? '';
  const path = fileURLToPath(uri);
  const name = basename(path);
  const b = bundle(path, text);
  const out: object[] = [];
  const mine = b.segments[b.segments.length - 1];

  const push = (d: Diagnostic, src: { locate(o: number): { line: number; col: number; file: string } }) => {
    const a = src.locate(d.span.start);
    if (a.file !== name) return;
    const z = src.locate(Math.max(d.span.end, d.span.start));
    out.push({
      range: { start: { line: a.line - 1, character: a.col - 1 }, end: { line: z.line - 1, character: z.col - 1 } },
      severity: d.severity === 'error' ? 1 : 2,
      code: d.code,
      source: 'lumen',
      message: d.hint ? `${d.message} (${d.hint})` : d.message,
    });
  };

  const fe = frontend(b.text, name, b.segments);
  last.set(uri, { fe, base: mine ? mine.start : 0, name });
  if (fe.ok) good.set(uri, { fe, base: mine ? mine.start : 0, name });
  // module errors (missing imports) come first, the rest of the pipeline still runs
  for (const d of b.diags) if (!mine || d.span.start >= mine.start) push(d, fe.source);
  for (const d of fe.diagnostics) push(d, fe.source);
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: out } });
}

// every node whose span covers `off`, outermost first. Symbol links (sym, decl, ...) are skipped: they point back up the tree
const LINKS = new Set(['sym', 'origin', 'from', 'decl', 'box']);

function pathAt(root: unknown, off: number): any[] {
  const path: any[] = [];
  const seen = new Set<object>();
  const walk = (n: any) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) return n.forEach(walk);
    const sp = n.span;
    // a fn's own span is only its header, so containment cannot prune the walk
    if (sp && typeof n.k === 'string' && off >= sp.start && off <= sp.end) path.push(n);
    for (const [key, v] of Object.entries(n)) {
      if (LINKS.has(key) || (key === 'fn' && !(v as any)?.k)) continue;
      walk(v);
    }
  };
  walk(root);
  return path;
}

function offsetOf(text: string, pos: { line: number; character: number }): number {
  let off = 0;
  for (let i = 0; i < pos.line; i++) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) return text.length;
    off = nl + 1;
  }
  return Math.min(off + pos.character, text.length);
}

function hover(uri: string, pos: { line: number; character: number }) {
  const a = last.get(uri);
  if (!a) return null;
  const path = pathAt(a.fe.program, a.base + offsetOf(docs.get(uri) ?? '', pos));
  for (const n of path.reverse()) {
    let text: string | undefined;
    if (n.k === 'call' && n.fn) text = `fn ${n.name}(${n.fn.params.join(', ')}): ${n.fn.ret}`;
    else if (n.k === 'var') text = `${n.sym?.mutable ? 'var' : 'let'} ${n.name}: ${n.ty}`;
    else if (n.k === 'field') text = `.${n.name}: ${n.ty}`;
    else if (typeof n.ty === 'string' && n.ty !== 'error' && n.ty !== 'void') text = n.ty;
    if (text) return { contents: { kind: 'markdown', value: '```lumen\n' + text + '\n```' } };
  }
  return null;
}

function definition(uri: string, pos: { line: number; character: number }) {
  const a = last.get(uri);
  if (!a) return null;
  const path = pathAt(a.fe.program, a.base + offsetOf(docs.get(uri) ?? '', pos));
  for (const n of path.reverse()) {
    const span = n.k === 'var' ? n.sym?.span : n.k === 'call' || n.k === 'fnref' ? n.fn?.decl?.nameSpan : undefined;
    if (!span) continue;
    const s = a.fe.source.locate(span.start);
    if (s.file !== a.name) return null; // lives in an imported file
    const e = a.fe.source.locate(span.end);
    return { uri, range: { start: { line: s.line - 1, character: s.col - 1 }, end: { line: e.line - 1, character: e.col - 1 } } };
  }
  return null;
}

const KEYWORDS = ['fn', 'let', 'var', 'if', 'else', 'while', 'for', 'in', 'impl', 'trait', 'pub', 'struct', 'enum', 'match', 'return', 'break', 'continue', 'true', 'false', 'import', 'loop', 'try'];

const range = (a: { locate(o: number): { line: number; col: number } }, sp: { start: number; end: number }) => {
  const s = a.locate(sp.start);
  const e = a.locate(sp.end);
  return { start: { line: s.line - 1, character: s.col - 1 }, end: { line: e.line - 1, character: e.col - 1 } };
};

// top-level fns, structs and enums that live in this file
function symbols(uri: string) {
  const a = last.get(uri);
  if (!a) return [];
  const p = a.fe.program;
  const mine = (sp: { start: number }) => a.fe.source.locate(sp.start).file === a.name;
  const out: object[] = [];
  const add = (name: string, kind: number, decl: { span: { start: number; end: number }; nameSpan: { start: number; end: number } }) => {
    if (!mine(decl.nameSpan)) return;
    out.push({ name: name.replace(/^.*\$/, ''), kind, range: range(a.fe.source, decl.span), selectionRange: range(a.fe.source, decl.nameSpan) });
  };
  for (const f of p.fns) if (!f.name.startsWith('lambda$') && !f.name.includes('$_')) add(f.name, 12, f);
  for (const s of p.structs) add(s.name, 23, s);
  for (const e of p.enums) add(e.name, 10, e);
  return out;
}

// text before the cursor decides: after `name.` the fields of that variable's struct, otherwise names in scope
function completion(uri: string, pos: { line: number; character: number }) {
  const a = good.get(uri) ?? last.get(uri);
  const text = docs.get(uri) ?? '';
  const off = offsetOf(text, pos);
  const dot = /([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z0-9_]*$/.exec(text.slice(Math.max(0, off - 80), off));
  if (dot && a) {
    let ty = '';
    const seen = new Set<object>();
    const find = (n: any) => {
      if (ty || !n || typeof n !== 'object' || seen.has(n)) return;
      seen.add(n);
      if (Array.isArray(n)) return n.forEach(find);
      if (n.k === 'var' && n.name === dot[1] && n.ty) ty = n.ty;
      for (const [key, v] of Object.entries(n)) if (!LINKS.has(key)) find(v);
    };
    find(a.fe.program.body);
    for (const f of a.fe.program.fns) find(f.body);
    const st = ty.startsWith('@') ? a.fe.program.structs.find(s => s.name === ty.slice(1)) : undefined;
    return (st?.fields ?? []).map(f => ({ label: f.name, kind: 5, detail: f.ty }));
  }
  const items: object[] = KEYWORDS.map(label => ({ label, kind: 14 }));
  for (const name of Object.keys(BUILTINS)) items.push({ label: name, kind: 3, detail: 'builtin' });
  if (a) {
    const seen = new Set<string>();
    for (const s of symbols(uri) as { name: string; kind: number }[]) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      items.push({ label: s.name, kind: s.kind === 12 ? 3 : s.kind === 23 ? 22 : 13 });
    }
  }
  return items;
}

function lineCount(text: string): { line: number; character: number } {
  const lines = text.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

function handle(m: any) {
  switch (m.method) {
    case 'initialize':
      return reply(m.id, {
        capabilities: { textDocumentSync: 1, documentFormattingProvider: true, hoverProvider: true, definitionProvider: true, documentSymbolProvider: true, completionProvider: { triggerCharacters: ['.'] } },
        serverInfo: { name: 'lumen' },
      });
    case 'shutdown':
      return reply(m.id, null);
    case 'exit':
      process.exit(0);
    case 'textDocument/didOpen':
      docs.set(m.params.textDocument.uri, m.params.textDocument.text);
      return diagnose(m.params.textDocument.uri);
    case 'textDocument/didChange': {
      const uri = m.params.textDocument.uri;
      docs.set(uri, m.params.contentChanges[m.params.contentChanges.length - 1].text);
      return diagnose(uri);
    }
    case 'textDocument/didClose':
      docs.delete(m.params.textDocument.uri);
      good.delete(m.params.textDocument.uri);
      return send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: m.params.textDocument.uri, diagnostics: [] } });
    case 'textDocument/hover':
      return reply(m.id, hover(m.params.textDocument.uri, m.params.position));
    case 'textDocument/definition':
      return reply(m.id, definition(m.params.textDocument.uri, m.params.position));
    case 'textDocument/completion':
      return reply(m.id, completion(m.params.textDocument.uri, m.params.position));
    case 'textDocument/documentSymbol':
      return reply(m.id, symbols(m.params.textDocument.uri));
    case 'textDocument/formatting': {
      const text = docs.get(m.params.textDocument.uri) ?? '';
      const done = format(text);
      if (done === text) return reply(m.id, []);
      return reply(m.id, [{ range: { start: { line: 0, character: 0 }, end: lineCount(text) }, newText: done }]);
    }
    default:
      // requests we do not know still need an answer or the client waits forever
      if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
  }
}

export function serve() {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const len = /Content-Length: *(\d+)/i.exec(buf.subarray(0, sep).toString('ascii'));
      if (!len) {
        buf = buf.subarray(sep + 4);
        continue;
      }
      const end = sep + 4 + Number(len[1]);
      if (buf.length < end) return;
      const msg = JSON.parse(buf.subarray(sep + 4, end).toString('utf8'));
      buf = buf.subarray(end);
      try {
        handle(msg);
      } catch (e) {
        // a bad request must not take the editor's server down
        process.stderr.write(`lumen lsp: ${msg.method}: ${(e as Error).message}\n`);
        if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: (e as Error).message } });
      }
    }
  });
}
