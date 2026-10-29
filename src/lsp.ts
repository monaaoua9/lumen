import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './modules.ts';
import { frontend } from './pipeline.ts';
import { format } from './fmt.ts';
import type { Diagnostic } from './diagnostics.ts';

// language server over stdio: diagnostics on every edit, and whole-document formatting
const docs = new Map<string, string>();

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
  // module errors (missing imports) come first, the rest of the pipeline still runs
  for (const d of b.diags) if (!mine || d.span.start >= mine.start) push(d, fe.source);
  for (const d of fe.diagnostics) push(d, fe.source);
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: out } });
}

function lineCount(text: string): { line: number; character: number } {
  const lines = text.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

function handle(m: any) {
  switch (m.method) {
    case 'initialize':
      return reply(m.id, {
        capabilities: { textDocumentSync: 1, documentFormattingProvider: true },
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
      return send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: m.params.textDocument.uri, diagnostics: [] } });
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
