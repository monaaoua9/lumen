// whitespace-only formatter: indentation follows bracket depth, nothing inside a line is touched.
// strings and comments are skipped when counting brackets, so a "{" in text does not shift the indent.
export function format(src: string, width = 2): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let depth = 0;
  let inBlock = false;
  let blanks = 0;

  for (const raw of lines) {
    const text = raw.trim();

    if (inBlock) {
      // inside /* */ the original layout is kept, only trailing space goes
      out.push(raw.replace(/\s+$/, ''));
      if (text.includes('*/')) inBlock = false;
      continue;
    }
    if (text === '') {
      if (++blanks === 1 && out.length > 0) out.push('');
      continue;
    }
    blanks = 0;

    // leading closers dedent this line, every bracket counts toward the next one
    let leading = 0;
    let counting = true;
    let net = 0;
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        counting = false;
      } else if (c === '/' && text[i + 1] === '/') {
        break;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) {
          inBlock = true;
          break;
        }
        i = end + 1;
        counting = false;
      } else if (c === '(' || c === '{' || c === '[') {
        net++;
        counting = false;
      } else if (c === ')' || c === '}' || c === ']') {
        net--;
        if (counting) leading++;
      } else if (c !== ' ' && c !== '\t') {
        counting = false;
      }
    }

    const level = Math.max(0, depth - leading);
    out.push(' '.repeat(level * width) + text);
    depth = Math.max(0, depth + net);
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}
