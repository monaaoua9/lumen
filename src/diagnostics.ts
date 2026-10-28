export interface Span {
  start: number;
  end: number;
}

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  span: Span;
  hint?: string;
}

export interface Segment {
  name: string;
  start: number;
  end: number;
}

export class Source {
  readonly text: string;
  readonly name: string;
  readonly segments: Segment[];
  private starts: number[] = [0];

  constructor(text: string, name = '<input>', segments: Segment[] = []) {
    this.text = text;
    this.name = name;
    this.segments = segments;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') this.starts.push(i + 1);
    }
  }

  // line numbers restart at 1 in every bundled file
  locate(off: number): { line: number; col: number; file: string } {
    const seg = this.segments.find(s => off >= s.start && off <= s.end);
    const g = this.locateGlobal(off);
    if (!seg) return { ...g, file: this.name };
    return { line: g.line - this.locateGlobal(seg.start).line + 1, col: g.col, file: seg.name };
  }

  lineText(line: number, file?: string): string {
    const seg = file ? this.segments.find(s => s.name === file) : undefined;
    return this.lineAt(seg ? line + this.locateGlobal(seg.start).line - 1 : line);
  }

  private locateGlobal(off: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: off - this.starts[lo] + 1 };
  }

  private lineAt(line: number): string {
    const s = this.starts[line - 1];
    const e = this.text.indexOf('\n', s);
    return this.text.slice(s, e === -1 ? undefined : e).replace(/\r$/, '');
  }
}

export class CompileError extends Error {
  diags: Diagnostic[];
  constructor(diags: Diagnostic[]) {
    super(diags[0]?.message ?? 'compile error');
    this.diags = diags;
  }
}

// thrown by exit(code); the cli turns it into the process exit status
export class ExitSignal extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export class RuntimeError extends Error {
  span?: Span;
  constructor(msg: string, span?: Span) {
    super(msg);
    this.span = span;
  }
}

const RED = '\x1b[31;1m';
const YELLOW = '\x1b[33;1m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export function render(src: Source, d: Diagnostic, color = false): string {
  const c = (code: string, s: string) => (color ? code + s + RESET : s);
  const { line, col, file } = src.locate(d.span.start);
  const text = src.lineText(line, file);
  const gutter = String(line).length;
  const pad = ' '.repeat(gutter);

  // multi-line spans: underline to the end of the first line only
  const endCol = src.locate(Math.max(d.span.start, d.span.end - 1));
  const width = endCol.line === line ? Math.max(1, endCol.col - col + 1) : Math.max(1, text.length - col + 1);

  const tag = d.severity === 'error' ? c(RED, `error[${d.code}]`) : c(YELLOW, `warning[${d.code}]`);
  const out = [
    `${tag}: ${d.message}`,
    `${pad}${c(CYAN, '-->')} ${file}:${line}:${col}`,
    `${pad} ${c(CYAN, '|')}`,
    `${c(CYAN, String(line))} ${c(CYAN, '|')} ${text}`,
    `${pad} ${c(CYAN, '|')} ${' '.repeat(col - 1)}${c(d.severity === 'error' ? RED : YELLOW, '^'.repeat(width))}`,
  ];
  if (d.hint) out.push(`${pad} ${c(CYAN, '=')} ${c(DIM, 'help:')} ${d.hint}`);
  return out.join('\n');
}

export function renderAll(src: Source, ds: Diagnostic[], color = false): string {
  return ds.map(d => render(src, d, color)).join('\n\n');
}
