import { CompileError, ExitSignal, RuntimeError } from './diagnostics.ts';
import { checked, execute } from './pipeline.ts';

// Every accepted input is appended to one growing program that is re-run from the top,
// and only the output past what was already shown gets printed. Side effects of earlier
// lines are therefore replayed (invisibly), which is fine for pure code and print.
export class Repl {
  program = '';
  shown = '';
  done = false;

  command(text: string): string {
    const [name, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    if (name === ':reset') {
      this.program = '';
      this.shown = '';
      return 'cleared\n';
    }
    if (name === ':type' && arg) {
      try {
        const fe = checked(`${this.program}let _repl_t = ${arg};\n`);
        const last = fe.program.body[fe.program.body.length - 1];
        return (last.k === 'let' ? last.init.ty.replace(/[@#]/g, '') : '?') + '\n';
      } catch (e) {
        if (!(e instanceof CompileError)) throw e;
        return e.diags.filter(d => d.severity === 'error').map(d => `error[${d.code}]: ${d.message}`).join('\n') + '\n';
      }
    }
    return ':type <expr>  type of an expression\n:reset        forget everything entered so far\n:help         this list\n';
  }

  feed(input: string): string {
    const text = input.trim();
    if (text === '') return '';
    if (text.startsWith(':')) return this.command(text);
    const tries = /[;}]$/.test(text) ? [text] : [`print(${text});`, text + ';'];

    let lastErr = '';
    for (const cand of tries) {
      const full = this.program + cand + '\n';
      let fe;
      try {
        fe = checked(full);
      } catch (e) {
        if (!(e instanceof CompileError)) throw e;
        lastErr = e.diags.filter(d => d.severity === 'error').map(d => `error[${d.code}]: ${d.message}`).join('\n');
        continue;
      }
      let out = '';
      try {
        execute(fe, 'vm', { out: s => { out += s; } });
      } catch (e) {
        if (e instanceof ExitSignal) {
          this.done = true;
          return out.slice(this.shown.length);
        }
        if (e instanceof RuntimeError) return `runtime error: ${e.message}\n`;
        throw e;
      }
      this.program = full;
      const fresh = out.slice(this.shown.length);
      this.shown = out;
      return fresh;
    }
    return lastErr + '\n';
  }
}

// true while brackets or a string are still open, so the next line belongs to the same input
export function incomplete(text: string): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '/' && text[i + 1] === '/') while (i < text.length && text[i] !== '\n') i++;
    else if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
  }
  return depth > 0;
}
