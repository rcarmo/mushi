import type { ConversationView, LiveState } from '@earendil-works/pi-durable';
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';

export type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'interrupted';
export interface Diagnostic { severity: string; message: string; code?: string }
export interface TextItem { kind: 'message' | 'thinking'; id: string; role: 'user' | 'assistant'; text: string; live: boolean; label?: string; error?: string }
export interface ToolItem {
  kind: 'tool'; id: string; callId: string; name: string; args: Record<string, unknown>;
  status: ToolStatus; output: string; diagnostics: Diagnostic[]; images: string[];
  details: Record<string, unknown>; durationMs?: number; exitCode?: number;
  complete: boolean; resultEntry?: number; note?: string; children: ToolItem[];
}
export type TranscriptItem = TextItem | ToolItem;
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function diagnostics(value: unknown): Diagnostic[] {
  return Array.isArray(value) ? value.flatMap(value => {
    const entry = object(value);
    return typeof entry.message === 'string' ? [{ severity: typeof entry.severity === 'string' ? entry.severity : 'info',
      message: entry.message, ...(typeof entry.code === 'string' ? { code: entry.code } : {}) }] : [];
  }) : [];
}
export function contentText(content: Message['content']) {
  return typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}
/** Strip only the exact SDK-generated diagnostic block backed by entry.data.
 * A file's literal <harness> content must never be guessed away by a regex.
 */
export function toolOutput(message: ToolResultMessage, notes: Diagnostic[]) {
  const parts = [...message.content];
  const expected = `<harness>\n${notes.map(note => `[${note.severity}] ${note.message}`).join('\n')}\n</harness>`;
  const last = parts.at(-1);
  if (notes.length && last?.type === 'text' && last.text === expected) parts.pop();
  return contentText(parts);
}
function tool(id: string, callId: string, name: string, args: unknown): ToolItem {
  return { kind: 'tool', id, callId, name, args: object(args), status: 'pending', output: '', diagnostics: [], images: [], details: {}, complete: false, children: [] };
}
function applyResult(item: ToolItem, message: ToolResultMessage, notes: Diagnostic[], entryId: number) {
  item.output = toolOutput(message, notes); item.details = object(message.details); item.diagnostics = notes;
  item.images = message.content.flatMap(part => part.type === 'image' ? [part.mimeType] : []);
  item.complete = true; item.resultEntry = entryId;
  item.status = notes.some(note => note.code === 'interrupted' || note.code === 'aborted') ? 'interrupted' : message.isError ? 'error' : 'done';
  if (typeof message.durationMs === 'number' && Number.isFinite(message.durationMs)) item.durationMs = message.durationMs;
  const exit = notes.find(note => note.code === 'exit_code')?.message.match(/Command exited with code (-?\d+)/);
  if (exit) item.exitCode = Number(exit[1]);
  else if (item.name === 'bash' && !message.isError) item.exitCode = 0;
}

/** Derive one card per actual call/result pair. Call IDs can repeat between
 * model responses; match results to the most recent still-unsettled call.
 * This projection never changes the durable transcript or model context.
 */
export function projectTranscript(view: ConversationView): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const calls = new Map<string, ToolItem[]>();
  const results = new Map<number, ToolItem[]>();
  const live = (view.docs['pi.live'] ?? {}) as LiveState;
  for (const entry of view.entries) {
    for (const [index, message] of (entry.model ?? []).entries()) {
      const key = `${entry.id}:${index}`;
      if (message.role === 'system') continue;
      if (message.role === 'toolResult') {
        const candidates = calls.get(message.toolCallId) ?? [];
        let item = [...candidates].reverse().find(call => !call.complete);
        if (!item) { item = tool(`result:${key}`, message.toolCallId, message.toolName || 'tool', {}); items.push(item); }
        applyResult(item, message, diagnostics(object(entry.data).diagnostics), entry.id);
        results.set(entry.id, [...(results.get(entry.id) ?? []), item]);
      } else if (message.role === 'user') {
        const text = contentText(message.content);
        if (text) items.push({ kind: entry.kind === 'pi.compaction' ? 'thinking' : 'message', id: `message:${key}`, role: 'user', text, live: false,
          ...(entry.kind === 'pi.compaction' ? { label: 'Context summary' } : {}) });
      } else {
        let block = 0;
        for (const part of message.content) {
          const id = `${key}:${block++}`;
          if (part.type === 'text' && part.text) items.push({ kind: 'message', id: `message:${id}`, role: 'assistant', text: part.text, live: false });
          else if (part.type === 'thinking' && part.thinking) items.push({ kind: 'thinking', id: `thinking:${id}`, role: 'assistant', text: part.thinking, live: false });
          else if (part.type === 'toolCall') {
            const item = tool(`tool:${id}`, part.id, part.name, part.arguments);
            calls.set(part.id, [...(calls.get(part.id) ?? []), item]); items.push(item);
          }
        }
        if (message.errorMessage) items.push({ kind: 'message', id: `error:${key}`, role: 'assistant', text: '', live: false, error: message.errorMessage });
      }
    }
  }
  const tasks = new Map<number, ToolItem>();
  const activeCalls = new Set<ToolItem>();
  for (const slot of live.tools ?? []) {
    const candidates = calls.get(slot.callId) ?? [];
    let item = slot.entry === undefined ? undefined : results.get(slot.entry)?.find(item => item.callId === slot.callId);
    item ??= [...candidates].reverse().find(call => !call.complete);
    if (!item) { item = tool(`slot:${slot.taskId ?? slot.callId}`, slot.callId, slot.name, {}); items.push(item); }
    activeCalls.add(item);
    if (!item.complete) {
      item.status = slot.status === 'done' ? 'interrupted' : slot.status;
      item.output = slot.output ?? ''; item.details = object(slot.details); item.diagnostics = diagnostics(slot.diagnostics);
      if (slot.status === 'done') item.note = 'No result available.';
    }
    if (slot.taskId !== undefined) tasks.set(slot.taskId, item);
  }
  for (const item of items) {
    if (item.kind === 'tool' && !item.complete && !activeCalls.has(item)) {
      item.status = 'interrupted'; item.note = 'No result available.';
    }
  }
  for (const slot of live.nestedTools ?? []) {
    const item = tool(`nested:${slot.taskId}`, slot.callId, slot.name, slot.arguments);
    item.status = slot.status === 'done' ? slot.summary?.isError ? 'error' : 'done' : slot.status;
    item.complete = slot.status === 'done'; item.output = slot.output ?? slot.summary?.error ?? '';
    item.durationMs = slot.summary?.durationMs; item.details = object(slot.details); item.diagnostics = diagnostics(slot.diagnostics);
    if (item.complete && !item.output) item.note = 'No output available.';
    const parent = tasks.get(slot.parentTaskId);
    if (parent) parent.children.push(item); else items.push(item);
    tasks.set(slot.taskId, item);
  }
  const partial = live.generation?.message as AssistantMessage | undefined;
  if (partial) {
    let index = 0;
    for (const part of partial.content) {
      const id = `partial:${live.run?.taskId ?? 'generation'}:${index++}`;
      if (part.type === 'text' && part.text) items.push({ kind: 'message', id, role: 'assistant', text: part.text, live: true });
      else if (part.type === 'thinking' && part.thinking) items.push({ kind: 'thinking', id, role: 'assistant', text: part.thinking, live: true });
    }
    // Partial tool-call JSON isn't a message. Its authoritative card appears
    // when the call is committed, then follows slot progress/result commits.
  }
  return items;
}

export function duration(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return '';
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1000;
  const rounded = Math.round(seconds);
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}
export function lineCount(text: string) { return text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length : 0; }
export function argument(item: ToolItem, key: string) { const value = item.args[key]; return typeof value === 'string' ? value : ''; }
export function editsOf(item: ToolItem): { oldText: string; newText: string }[] {
  let edits = item.args.edits;
  if (typeof edits === 'string') { try { edits = JSON.parse(edits); } catch { edits = undefined; } }
  if (!Array.isArray(edits)) edits = edits ? [edits] : [];
  const legacy = typeof item.args.oldText === 'string' && typeof item.args.newText === 'string' ? [{ oldText: item.args.oldText, newText: item.args.newText }] : [];
  return [...(edits as unknown[]), ...legacy].flatMap(value => {
    const edit = object(value);
    return typeof edit.oldText === 'string' && typeof edit.newText === 'string' ? [{ oldText: edit.oldText, newText: edit.newText }] : [];
  });
}
