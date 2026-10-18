export interface TerminalSegment { text: string; classes: string[] }
const colors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
function normalized(text: string) { return text.replace(/\r\n/g, '\n').split('\n').map(line => line.split('\r').at(-1) ?? '').join('\n'); }
/** A display-only SGR subset. Drop OSC (including clipboard/hyperlink commands),
 * cursor operations and nonprinting controls; never turn output into HTML/links.
 */
export function terminalSegments(source: string): TerminalSegment[] {
  const text = normalized(source), result: TerminalSegment[] = [];
  const escape = /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\[[0-?]*[ -/]*$|\x1b[@-_]/g;
  let offset = 0, foreground = '', background = '', bold = false, dim = false, italic = false, underline = false;
  const append = (value: string) => {
    const clean = value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    if (clean) result.push({ text: clean, classes: [foreground, background, bold ? 'term-bold' : '', dim ? 'term-dim' : '', italic ? 'term-italic' : '', underline ? 'term-underline' : ''].filter(Boolean) });
  };
  for (const match of text.matchAll(escape)) {
    append(text.slice(offset, match.index)); offset = match.index! + match[0].length;
    if (!/^\x1b\[[0-9;]*m$/.test(match[0])) continue;
    const codes = match[0].slice(2, -1).split(';').map(value => Number(value || 0));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0) { foreground = background = ''; bold = dim = italic = underline = false; }
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 3) italic = true;
      else if (code === 4) underline = true;
      else if (code === 22) bold = dim = false;
      else if (code === 23) italic = false;
      else if (code === 24) underline = false;
      else if (code === 39) foreground = '';
      else if (code === 49) background = '';
      else if (code >= 30 && code <= 37) foreground = `term-fg-${colors[code - 30]}`;
      else if (code >= 90 && code <= 97) foreground = `term-fg-${colors[code - 90]}`;
      else if (code >= 40 && code <= 47) background = `term-bg-${colors[code - 40]}`;
      else if (code >= 100 && code <= 107) background = `term-bg-${colors[code - 100]}`;
      else if ((code === 38 || code === 48) && codes[i + 1] === 5) i += 2;
      else if ((code === 38 || code === 48) && codes[i + 1] === 2) i += 4;
    }
  }
  append(text.slice(offset));
  return result;
}
export function plainTerminal(source: string) { return terminalSegments(source).map(part => part.text).join(''); }
