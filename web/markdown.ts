import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { CodeView, type Copy } from './code.ts';
import { installRuby } from './ruby.ts';

export interface RenderActions { copy: Copy; openLink: (url: string) => Promise<void> }
export function safeHttpsLink(value: string): string | null {
  if (value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : null;
  } catch { return null; }
}
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
installRuby(markdown);
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
markdown.linkify.add('ftp:', null).add('//', null).add('mailto:', null);
const tags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);

/** Markdown is tokenized, then rendered using a fixed DOM vocabulary. No model
 * HTML, event attributes, remote images, or executable links are ever inserted.
 */
export function markdownNodes(source: string, actions: RenderActions) {
  const fragment = document.createDocumentFragment();
  function render(tokens: Token[], root: HTMLElement | DocumentFragment, stripReadingLabel = false) {
    const stack: (HTMLElement | DocumentFragment)[] = [root];
    for (const [index, token] of tokens.entries()) {
      const parent = () => stack.at(-1)!;
      if (token.hidden) continue;
      if (token.type === 'inline') {
        const host = parent();
        const labeled = /^(?:Romaji:|\*\*Romaji:\*\*|__Romaji:__)\s*/i.test(token.content);
        render(token.children ?? [], host, host instanceof HTMLElement && host.tagName === 'P' && labeled); continue;
      }
      if (token.type === 'text') {
        let text = token.content;
        if (stripReadingLabel && text.trim()) { text = text.replace(/^Romaji:\s*/i, ''); stripReadingLabel = false; }
        const host = parent(), task = text.match(/^\[([ xX])\]\s+/);
        if (host instanceof HTMLElement && host.tagName === 'LI' && !host.childNodes.length && task) {
          const checked = task[1]!.toLowerCase() === 'x', box = document.createElement('span');
          host.classList.add('task-item'); box.className = checked ? 'task-box checked' : 'task-box';
          box.setAttribute('role', 'img'); box.setAttribute('aria-label', checked ? 'Completed' : 'Not completed'); box.textContent = checked ? '✓' : '';
          host.append(box, document.createTextNode(text.slice(task[0].length)));
        } else host.append(document.createTextNode(text));
        continue;
      }
      if (token.type === 'softbreak') { parent().append(document.createTextNode('\n')); continue; }
      if (token.type === 'hardbreak') { parent().append(document.createElement('br')); continue; }
      if (token.type === 'hr') { parent().append(document.createElement('hr')); continue; }
      if (token.type === 'code_inline') { const code = document.createElement('code'); code.textContent = token.content; parent().append(code); continue; }
      if (token.type === 'fence' || token.type === 'code_block') {
        const [language = '', ...info] = token.info.trim().split(/\s+/);
        const filename = info.join(' ').replace(/^filename=["']?|["']$/g, '');
        const block = new CodeView(actions.copy);
        block.update(token.content.replace(/\n$/, ''), { language, title: filename || language || 'Code', diff: language.toLowerCase() === 'diff', initialLines: 160 });
        parent().append(block.element); continue;
      }
      if (token.type === 'ruby_annotation') {
        const base = token.meta?.base, reading = token.meta?.reading;
        if (typeof base !== 'string' || typeof reading !== 'string') continue;
        const ruby = document.createElement('ruby'); ruby.lang = 'ja'; ruby.append(document.createTextNode(base));
        const start = document.createElement('rp'), rt = document.createElement('rt'), end = document.createElement('rp');
        start.textContent = '('; rt.textContent = reading; end.textContent = ')'; ruby.append(start, rt, end); parent().append(ruby); continue;
      }
      if (token.type === 'image') {
        const note = document.createElement('span'); note.className = 'attachment-note';
        note.textContent = `[Image${token.content ? `: ${token.content}` : ''}]`; parent().append(note); continue;
      }
      if (token.type === 'link_open') {
        const href = token.attrGet('href') ?? '', safe = safeHttpsLink(href);
        const link = document.createElement(safe ? 'a' : 'span');
        if (link instanceof HTMLAnchorElement && safe) {
          link.href = safe; link.rel = 'noopener noreferrer'; link.title = safe;
          link.addEventListener('click', event => { event.preventDefault(); void actions.openLink(safe); });
        } else { link.className = 'file-reference'; link.title = href.slice(0, 4096); }
        parent().append(link); stack.push(link); continue;
      }
      if (token.type === 'link_close') { if (stack.length > 1) stack.pop(); continue; }
      if (token.nesting === 1 && tags.has(token.tag)) {
        const element = document.createElement(token.tag);
        if (token.tag === 'p') {
          const text = tokens[index + 1]?.content ?? '';
          const previous = tokens[index - 3]?.type === 'paragraph_open' ? tokens[index - 2]?.content ?? '' : '';
          const labeled = /^(?:Romaji:|\*\*Romaji:\*\*|__Romaji:__)\s*/i.test(text);
          const reading = /[一-龯ぁ-ゖァ-ヺ]/.test(previous) && !/[一-龯ぁ-ゖァ-ヺ]/.test(text) && /^[A-Za-zĀ-ž]/.test(text);
          if (labeled || reading) { element.classList.add('romaji'); element.lang = 'ja-Latn'; }
        }
        if (token.tag === 'ol') {
          const start = Number(token.attrGet('start'));
          if (Number.isInteger(start) && start > 0 && start < 1000000) element.setAttribute('start', String(start));
        }
        if (token.tag === 'th' || token.tag === 'td') {
          const align = token.attrGet('style')?.match(/^text-align:(left|center|right)$/)?.[1];
          if (align) element.className = `align-${align}`;
        }
        if (token.tag === 'table') { const scroll = document.createElement('div'); scroll.className = 'table-scroll'; scroll.append(element); parent().append(scroll); }
        else parent().append(element);
        stack.push(element); continue;
      }
      if (token.nesting === -1 && tags.has(token.tag)) { if (stack.length > 1) stack.pop(); continue; }
      if (token.content) parent().append(document.createTextNode(token.content));
    }
  }
  render(markdown.parse(source, {}), fragment);
  return fragment;
}

/** Conservative append-only block boundaries, adapted from Kintsugi's streaming
 * Markdown renderer (MIT, Lucas Meijer). Lists/quotes/references stay in the
 * mutable tail because later input can change their meaning. */
export function stableMarkdownBoundary(source: string) {
  let boundary = 0, offset = 0;
  let fence: { marker: string; size: number } | undefined;
  let outside: string[] = [];
  for (const raw of source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? []) {
    const line = raw.replace(/(?:\r\n|\r|\n)$/, ''), start = offset; offset += raw.length;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const wasInFence = !!fence;
    if (marker) {
      if (!fence && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) fence = { marker: marker[1]![0]!, size: marker[1]!.length };
      else if (fence && marker[1]![0] === fence.marker && marker[1]!.length >= fence.size && /^[ \t]*$/.test(marker[2]!)) fence = undefined;
    }
    if (!wasInFence && !fence) outside.push(line);
    if (!/[\r\n]$/.test(raw) || (raw.endsWith('\r') && offset === source.length) || fence || !/^[ \t]*$/.test(line)) continue;
    const candidate = source.slice(boundary, start);
    const contextual = outside.some(line => line.includes('[') || /^(?: {4}|\t| {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)| {0,3}>)/.test(line));
    const table = outside.some(line => /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line));
    if (candidate.trim() && !contextual && !table) { boundary = offset; outside = []; }
  }
  return boundary;
}

export class MarkdownView {
  readonly element = document.createElement('div');
  private stable = document.createElement('div');
  private tail = document.createElement('div');
  private source = '';
  private boundary = 0;
  constructor(private actions: RenderActions) { this.element.className = 'markdown'; this.stable.className = this.tail.className = 'markdown-region'; this.element.append(this.stable, this.tail); }
  update(source: string, streaming: boolean) {
    if (!streaming || !source.startsWith(this.source)) {
      this.boundary = 0; this.stable.replaceChildren(); this.tail.replaceChildren(markdownNodes(source, this.actions));
    } else {
      const boundary = stableMarkdownBoundary(source);
      if (boundary > this.boundary) this.stable.append(markdownNodes(source.slice(this.boundary, boundary), this.actions));
      this.boundary = Math.max(this.boundary, boundary);
      this.tail.replaceChildren(markdownNodes(source.slice(this.boundary), this.actions));
    }
    this.source = source;
  }
}
