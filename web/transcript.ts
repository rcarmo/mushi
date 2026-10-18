import { createPatch } from 'diff';
import type { ConversationView } from '@earendil-works/pi-durable';
import { CodeView, languageFor, type CodeOptions } from './code.ts';
import { MarkdownView, type RenderActions } from './markdown.ts';
import { projectTranscript, argument, editsOf, duration, type ToolItem, type TextItem, type TranscriptItem } from './transcript-model.ts';

function sync(container: HTMLElement, nodes: HTMLElement[]) {
  let cursor = container.firstElementChild;
  for (const node of nodes) {
    if (cursor === node) cursor = cursor.nextElementSibling;
    else container.insertBefore(node, cursor);
  }
  while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
}
const toolNames: Record<string, string> = { bash: 'Run', read: 'Read', write: 'Write', edit: 'Edit', codemode: 'Script', ls: 'List', find: 'Find', grep: 'Search files', http_request: 'HTTP', web_fetch: 'Fetch page', web_search: 'Search web' };
const label = (name: string) => Object.hasOwn(toolNames, name) ? toolNames[name]! : name;
function patchOf(item: ToolItem) {
  if (typeof item.details.patch === 'string') return item.details.patch;
  const path = argument(item, 'path') || 'replacement';
  return editsOf(item).map(edit => createPatch(path, edit.oldText, edit.newText, 'before', 'after', { context: 3 })).join('\n');
}
function changeStats(patch: string) {
  let added = 0, deleted = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) deleted++;
  }
  return { added, deleted };
}

class MessageRow {
  readonly element: HTMLElement;
  private markdown: MarkdownView;
  private header = document.createElement('div');
  private error = document.createElement('p');
  private fingerprint = '';
  constructor(item: TextItem, actions: RenderActions) {
    this.element = document.createElement(item.kind === 'thinking' ? 'details' : 'section');
    this.element.className = item.kind === 'thinking' ? 'reasoning' : `message ${item.role}`;
    this.header.className = 'role';
    if (item.kind === 'thinking') { const summary = document.createElement('summary'); summary.textContent = item.label ?? 'Reasoning'; this.element.append(summary); }
    else { this.header.textContent = item.role === 'user' ? 'You' : 'Mushi'; this.element.append(this.header); }
    this.markdown = new MarkdownView(actions); this.error.className = 'message-error'; this.error.setAttribute('role', 'status');
    this.element.append(this.markdown.element, this.error);
  }
  update(item: TextItem) {
    const fingerprint = JSON.stringify(item);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.element.classList.toggle('streaming', item.live);
    this.markdown.update(item.text, item.live);
    this.markdown.element.hidden = !item.text;
    this.error.textContent = item.error ?? ''; this.error.hidden = !item.error;
    if (item.kind !== 'thinking') this.header.textContent = item.live ? 'Mushi · writing' : item.role === 'user' ? 'You' : 'Mushi';
  }
}

class ToolRow {
  readonly element = document.createElement('details');
  private summary = document.createElement('summary');
  private dot = document.createElement('span');
  private name = document.createElement('span');
  private target = document.createElement('span');
  private meta = document.createElement('span');
  private body = document.createElement('div');
  private regions = document.createElement('div');
  private notes = document.createElement('div');
  private children = document.createElement('div');
  private code = new Map<string, CodeView>();
  private nested = new Map<string, ToolRow>();
  private item: ToolItem;
  private fingerprint = '';
  private drawn = '';
  private touched = false;
  constructor(item: ToolItem, private actions: RenderActions) {
    this.item = item; this.element.className = 'tool-card';
    this.dot.className = 'tool-status'; this.name.className = 'tool-name'; this.target.className = 'tool-target'; this.meta.className = 'tool-meta';
    this.summary.append(this.dot, this.name, this.target, this.meta);
    this.body.className = 'tool-body'; this.regions.className = 'tool-regions'; this.notes.className = 'tool-notes'; this.children.className = 'nested-tools';
    this.body.append(this.regions, this.notes, this.children); this.element.append(this.summary, this.body);
    this.summary.addEventListener('click', () => { this.touched = true; });
    this.body.addEventListener('pointerdown', () => { this.touched = true; });
    this.body.addEventListener('keydown', () => { this.touched = true; });
    this.body.addEventListener('click', () => { this.touched = true; });
    this.body.addEventListener('wheel', () => { this.touched = true; }, { passive: true });
    this.element.addEventListener('toggle', () => { if (this.element.open) this.draw(); });
  }
  update(item: ToolItem) {
    const fingerprint = JSON.stringify(item);
    if (fingerprint === this.fingerprint) return;
    const previous = this.item.status;
    this.item = item;
    this.fingerprint = fingerprint;
    this.element.dataset.status = item.status;
    this.dot.setAttribute('aria-label', { pending: 'Queued', running: 'Running', done: 'Complete', error: 'Failed', interrupted: 'Interrupted' }[item.status]);
    this.name.textContent = label(item.name);
    const path = argument(item, 'path') || argument(item, 'file_path');
    const command = argument(item, 'command').replace(/\s+/g, ' ').trim();
    const offset = typeof item.args.offset === 'number' && item.args.offset > 0 ? item.args.offset : 1;
    const limit = typeof item.args.limit === 'number' && item.args.limit > 0 ? item.args.limit : undefined;
    const unusualOffset = typeof item.args.offset === 'number' && (!Number.isInteger(item.args.offset) || item.args.offset < 1);
    const range = item.name === 'read' && unusualOffset ? ` · offset ${item.args.offset}` :
      item.name === 'read' && (item.args.offset || limit) ? `:${offset}${limit ? `–${offset + limit - 1}` : ''}` : '';
    const target = item.name === 'codemode' ? argument(item, 'code').split('\n').find(line => line.trim() && !line.trim().startsWith('//'))?.trim() ?? '' : item.name === 'bash' ? command : argument(item, 'url') || argument(item, 'query') || argument(item, 'pattern') || path + range;
    this.target.textContent = target.length > 130 ? target.slice(0, 129) + '…' : target;
    this.target.title = target.slice(0, 4096);
    const stats = item.name === 'edit' ? changeStats(patchOf(item)) : undefined;
    const status = item.status === 'done' ? (item.name === 'bash' && item.exitCode !== undefined ? `exit ${item.exitCode}` : 'Done') :
      item.status === 'error' ? (item.exitCode !== undefined ? `exit ${item.exitCode}` : 'Failed') : item.status === 'interrupted' ? 'Stopped' : item.status === 'running' ? 'Running' : 'Queued';
    this.meta.textContent = [stats && (stats.added || stats.deleted) && item.status === 'done' ? `+${stats.added} −${stats.deleted}` : '', status, duration(item.durationMs)].filter(Boolean).join(' · ');
    if (!this.touched) {
      if (item.status === 'running' && item.name === 'bash') this.element.open = true;
      else if (previous === 'running' || item.status === 'error' || item.status === 'interrupted') this.element.open = item.status === 'error' || item.status === 'interrupted';
    }
    if (this.element.open) this.draw();
  }
  private codeRegion(key: string, text: string, options: CodeOptions) {
    let view = this.code.get(key);
    if (!view) { view = new CodeView(this.actions.copy); this.code.set(key, view); }
    view.update(text, options); return view.element;
  }
  private draw() {
    if (this.drawn === this.fingerprint) return;
    this.drawn = this.fingerprint;
    const item = this.item, path = argument(item, 'path') || argument(item, 'file_path');
    const nodes: HTMLElement[] = [];
    if (item.name === 'bash') nodes.push(this.codeRegion('command', argument(item, 'command'), { title: 'Command', language: 'bash', initialLines: 40 }));
    else if (item.name === 'codemode') nodes.push(this.codeRegion('script', argument(item, 'code'), { title: 'Script', language: 'javascript', lineStart: 1 }));
    else if (item.name === 'write') nodes.push(this.codeRegion('source', argument(item, 'content'), { title: item.status === 'done' ? `Written · ${path}` : `Requested content · ${path}`, language: languageFor(path), lineStart: 1 }));
    else if (item.name === 'edit') {
      const patch = patchOf(item);
      if (patch) nodes.push(this.codeRegion('patch', patch, { title: typeof item.details.patch === 'string' ? `Changes · ${path}` : `Requested replacements · ${path}`, diff: true, initialLines: 140 }));
    } else if (item.name !== 'read' && Object.keys(item.args).length) nodes.push(this.codeRegion('arguments', JSON.stringify(item.args, null, 2), { title: 'Arguments', language: 'json' }));
    const simpleReceipt = ['write', 'edit'].includes(item.name) && item.status === 'done' && /^Successfully\b/.test(item.output);
    if (!simpleReceipt && (item.output || item.name === 'bash' || item.name === 'read')) {
      let output = item.output, language = '', lineStart: number | undefined;
      if (item.name === 'read' && item.status !== 'error' && item.status !== 'interrupted') {
        language = languageFor(path);
        lineStart = item.args.offset === undefined ? 1 : typeof item.args.offset === 'number' && Number.isInteger(item.args.offset) && item.args.offset > 0 ? item.args.offset : undefined;
      }
      else if (item.name !== 'bash' && /^\s*[\[{]/.test(output)) {
        try { const value = JSON.parse(output); if (value && typeof value === 'object') { output = JSON.stringify(value, null, 2); language = 'json'; } } catch { /* Non-JSON tool text stays literal. */ }
      }
      nodes.push(this.codeRegion('output', output, { title: item.status === 'error' ? 'Error output' : item.name === 'read' ? `Read · ${path}` : 'Output', language,
        lineStart, ansi: item.name === 'bash', tail: item.name === 'bash', initialLines: item.name === 'bash' ? 60 : 120 }));
    }
    sync(this.regions, nodes);
    const notes: HTMLElement[] = [];
    for (const diagnostic of item.diagnostics) {
      const note = document.createElement('p'); note.className = `tool-note ${diagnostic.severity === 'error' ? 'danger' : diagnostic.severity === 'warn' ? 'warning' : ''}`;
      note.textContent = diagnostic.message; notes.push(note);
    }
    if (item.note) { const note = document.createElement('p'); note.className = 'tool-note'; note.textContent = item.note; notes.push(note); }
    if (item.images.length) { const note = document.createElement('p'); note.className = 'attachment-note'; note.textContent = `${item.images.length} image attachment${item.images.length === 1 ? '' : 's'} · ${item.images.join(', ')}`; notes.push(note); }
    this.notes.replaceChildren(...notes); this.notes.hidden = !notes.length;
    const children: HTMLElement[] = [];
    for (const child of item.children) {
      let row = this.nested.get(child.id); if (!row) { row = new ToolRow(child, this.actions); this.nested.set(child.id, row); }
      row.update(child); children.push(row.element);
    }
    sync(this.children, children); this.children.hidden = !children.length;
    for (const id of this.nested.keys()) if (!item.children.some(item => item.id === id)) this.nested.delete(id);
  }
}

/** Keep rows mounted across progress/usage commits: disclosures, selected text,
 * command panes and output scroll positions are not reset by the polling loop. */
export class TranscriptRenderer {
  private rows = new Map<string, { row: MessageRow | ToolRow; kind: TranscriptItem['kind'] }>();
  private empty = document.createElement('p');
  constructor(private container: HTMLElement, private actions: RenderActions) { this.empty.className = 'empty-state'; this.empty.textContent = 'What would you like to do?'; }
  render(view: ConversationView) {
    const items = projectTranscript(view), nodes: HTMLElement[] = [], active = new Set<string>();
    for (const item of items) {
      active.add(item.id);
      let cached = this.rows.get(item.id);
      if (!cached || cached.kind !== item.kind) {
        cached = { row: item.kind === 'tool' ? new ToolRow(item, this.actions) : new MessageRow(item, this.actions), kind: item.kind };
        this.rows.set(item.id, cached);
      }
      if (item.kind === 'tool' && cached.row instanceof ToolRow) cached.row.update(item);
      else if (item.kind !== 'tool' && cached.row instanceof MessageRow) cached.row.update(item);
      nodes.push(cached.row.element);
    }
    sync(this.container, nodes.length ? nodes : [this.empty]);
    for (const id of this.rows.keys()) if (!active.has(id)) this.rows.delete(id);
    return { tools: items.filter(item => item.kind === 'tool').length, items: items.length };
  }
}
