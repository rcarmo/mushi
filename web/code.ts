import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import { terminalSegments, plainTerminal } from './terminal.ts';

for (const [name, language] of Object.entries({ javascript, typescript, json, bash, python, css, xml, markdown, go, rust, sql })) hljs.registerLanguage(name, language);
const aliases: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash', py: 'python', html: 'xml', svg: 'xml', md: 'markdown', rs: 'rust' };
export type Copy = (text: string) => Promise<void>;
export function languageFor(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  return Object.hasOwn(aliases, extension) ? aliases[extension]! : (hljs.getLanguage(extension) ? extension : '');
}
const entity: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&#x2F;': '/' };
/** Highlight.js emits escaped text and spans. Decode its narrow vocabulary into
 * DOM nodes, not innerHTML/DOMParser; authored HTML never becomes an element.
 */
export function syntaxNodes(code: string, language: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lower = language.toLowerCase();
  const canonical = Object.hasOwn(aliases, lower) ? aliases[lower]! : lower;
  if (!hljs.getLanguage(canonical) || code.length > 40000) { fragment.append(document.createTextNode(code)); return fragment; }
  const marked = hljs.highlight(code, { language: canonical, ignoreIllegals: true }).value;
  const stack: (DocumentFragment | HTMLElement)[] = [fragment];
  for (const piece of marked.split(/(<\/?span(?: class="[a-zA-Z0-9_ -]+")?>)/g)) {
    const open = piece.match(/^<span class="([a-zA-Z0-9_ -]+)">$/);
    if (open) {
      const node = document.createElement('span');
      node.className = open[1]!.split(' ').filter(name => /^(hljs-[a-z0-9_-]+|[a-z0-9]+_)$/.test(name)).join(' ');
      stack.at(-1)!.append(node); stack.push(node);
    } else if (piece === '</span>' && stack.length > 1) stack.pop();
    else if (piece) stack.at(-1)!.append(document.createTextNode(piece.replace(/&(?:amp|lt|gt|quot|#x27|#39|#x2F);/g, value => entity[value]!)));
  }
  return fragment;
}
export interface CodeOptions { title?: string; language?: string; lineStart?: number; tail?: boolean; ansi?: boolean; initialLines?: number; diff?: boolean }
export class CodeView {
  readonly element = document.createElement('section');
  private label = document.createElement('span');
  private copyButton = document.createElement('button');
  private scroll = document.createElement('div');
  private code = document.createElement('code');
  private gutter = document.createElement('pre');
  private more = document.createElement('button');
  private less = document.createElement('button');
  private countLabel = document.createElement('span');
  private window = document.createElement('div');
  private text = '';
  private options: CodeOptions = {};
  private count = 0;
  constructor(private copy: Copy) {
    this.element.className = 'code-block';
    const bar = document.createElement('div'); bar.className = 'code-bar';
    this.label.className = 'code-label'; this.copyButton.type = 'button'; this.copyButton.className = 'copy-button'; this.copyButton.textContent = 'Copy';
    this.copyButton.onclick = async () => {
      try { await this.copy(this.options.ansi ? plainTerminal(this.text) : this.text); this.copyButton.textContent = 'Copied'; }
      catch { this.copyButton.textContent = 'Copy failed'; }
      setTimeout(() => { this.copyButton.textContent = 'Copy'; }, 1800);
    };
    bar.append(this.label, this.copyButton);
    this.scroll.className = 'code-scroll'; this.scroll.dataset.scroll = 'code';
    const pre = document.createElement('pre'); pre.append(this.code);
    this.gutter.className = 'line-numbers'; this.gutter.setAttribute('aria-hidden', 'true');
    this.scroll.append(this.gutter, pre);
    const footer = this.window; footer.className = 'code-window';
    this.more.type = this.less.type = 'button'; this.more.className = this.less.className = 'text-button';
    this.more.onclick = () => { this.count += 200; this.draw(); };
    this.less.textContent = 'Show less'; this.less.onclick = () => { this.count = this.options.initialLines ?? 120; this.draw(); };
    footer.append(this.countLabel, this.more, this.less);
    this.element.append(bar, this.scroll, footer);
  }
  update(text: string, options: CodeOptions = {}) {
    if (this.text === text && JSON.stringify(this.options) === JSON.stringify(options)) return;
    const first = this.count === 0;
    this.text = text; this.options = options;
    if (first) this.count = options.initialLines ?? 120;
    this.draw();
  }
  private draw() {
    const wasTail = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 45;
    const top = this.scroll.scrollTop, left = this.scroll.scrollLeft;
    const plain = this.options.ansi ? plainTerminal(this.text) : this.text.replace(/\r\n/g, '\n');
    const lines = plain.replace(/\n$/, '').split('\n');
    const actualLines = plain ? lines.length : 0;
    const hidden = Math.max(0, actualLines - this.count);
    const start = this.options.tail ? hidden : 0;
    const shown = lines.slice(start, start + this.count).join('\n');
    this.label.textContent = this.options.title ?? this.options.language ?? 'Code';
    this.label.title = this.options.title ?? '';
    this.copyButton.disabled = !plain || plain.length > 65536;
    this.copyButton.title = plain.length > 65536 ? 'Clipboard limit: 64K characters' : 'Copy text';
    this.code.replaceChildren();
    if (this.options.diff) {
      for (const line of shown.split('\n')) {
        const span = document.createElement('span'); span.className = 'diff-line';
        if (line.startsWith('@@')) span.classList.add('diff-hunk');
        else if (/^(diff |index |--- |\+\+\+ )/.test(line)) span.classList.add('diff-meta');
        else if (line.startsWith('+')) span.classList.add('diff-add');
        else if (line.startsWith('-')) span.classList.add('diff-delete');
        span.textContent = line || ' '; this.code.append(span);
      }
    } else if (this.options.ansi) {
      // Keep SGR coloring only when the whole retained window is shown. A cut
      // terminal stream may begin mid-style; plain tail text is unambiguous.
      const segments = hidden ? [{ text: shown, classes: [] }] : terminalSegments(this.text);
      for (const part of segments) { const span = document.createElement('span'); span.className = part.classes.join(' '); span.textContent = part.text; this.code.append(span); }
    } else this.code.append(syntaxNodes(shown, this.options.language ?? ''));
    if (!plain) this.code.textContent = 'No output';
    this.gutter.hidden = this.options.lineStart === undefined || !actualLines;
    this.scroll.classList.toggle('numbered', !this.gutter.hidden);
    this.gutter.textContent = this.gutter.hidden ? '' : lines.slice(start, start + this.count).map((_, index) => String((this.options.lineStart ?? 1) + start + index)).join('\n');
    this.countLabel.textContent = hidden ? `Showing ${this.options.tail ? 'last' : 'first'} ${Math.min(this.count, actualLines)} of ${actualLines} lines` : `${actualLines} ${actualLines === 1 ? 'line' : 'lines'}`;
    this.more.hidden = !hidden; this.more.textContent = `Show ${Math.min(200, hidden)} more`;
    this.less.hidden = this.count <= (this.options.initialLines ?? 120);
    this.window.hidden = !hidden && this.less.hidden;
    this.scroll.scrollLeft = left;
    this.scroll.scrollTop = this.options.tail && wasTail ? this.scroll.scrollHeight : top;
    if (this.options.tail && wasTail) requestAnimationFrame(() => { if (this.element.isConnected) this.scroll.scrollTop = this.scroll.scrollHeight; });
  }
}
