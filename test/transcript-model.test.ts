import { expect, test } from 'bun:test';
import type { ConversationView } from '@earendil-works/pi-durable';
import { projectTranscript, toolOutput, duration, editsOf, type ToolItem } from '../web/transcript-model.ts';
import { safeHttpsLink, stableMarkdownBoundary } from '../web/markdown.ts';
import { plainTerminal, terminalSegments } from '../web/terminal.ts';
import { languageFor } from '../web/code.ts';

// Wire-format fixtures; numeric IDs are branded only by the real harness.
function view(entries: object[], live: object = {}): ConversationView {
  return JSON.parse(JSON.stringify({ conversation: { id: 1 }, entries, docs: { 'pi.live': live } }));
}
function call(id: number, callId: string, name: string, args: object) {
  return { id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }], stopReason: 'toolUse' }] };
}
function result(id: number, callId: string, text: string, isError = false, data: object = {}) {
  return { id, kind: 'pi.tool-result', data, model: [{ role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text }], isError, durationMs: 720 }] };
}
function tools(value: ConversationView) { return projectTranscript(value).filter((item): item is ToolItem => item.kind === 'tool'); }

test('transcript projection pairs actual calls and results without duplicate rows or mutation', () => {
  const value = view([call(1, 'a', 'bash', { command: 'git status' }), result(2, 'a', 'clean')]);
  const original = JSON.stringify(value), projected = tools(value);
  expect(projected).toHaveLength(1);
  expect(projected[0]?.args.command).toBe('git status');
  expect(projected[0]?.output).toBe('clean'); expect(projected[0]?.status).toBe('done');
  expect(projected[0]?.exitCode).toBe(0); expect(projected[0]?.durationMs).toBe(720);
  expect(JSON.stringify(value)).toBe(original);
});

test('reused provider call IDs match the latest unsettled call, not an earlier round', () => {
  const value = view([call(1, 'same', 'bash', { command: 'first' }), result(2, 'same', 'one'), call(3, 'same', 'bash', { command: 'second' }), result(4, 'same', 'two', true)]);
  const projected = tools(value);
  expect(projected.map(item => item.output)).toEqual(['one', 'two']);
  expect(projected.map(item => item.status)).toEqual(['done', 'error']);
  expect(projected[0]?.id).not.toBe(projected[1]?.id);
});

test('structured diagnostics are separate from file content; literal harness markup is preserved', () => {
  const notes = [{ severity: 'error', code: 'exit_code', message: 'Command exited with code 7' }];
  const annotation = '<harness>\n[error] Command exited with code 7\n</harness>';
  const entry = result(2, 'a', annotation, true, { diagnostics: notes });
  entry.model[0]!.content.push({ type: 'text', text: annotation });
  const projected = tools(view([call(1, 'a', 'bash', { command: 'exit 7' }), entry]));
  expect(projected[0]?.output).toBe(annotation); // only the SDK-appended copy removed
  expect(projected[0]?.diagnostics).toEqual(notes);
  expect(projected[0]?.exitCode).toBe(7); expect(projected[0]?.status).toBe('error');
  const literal = tools(view([result(3, 'orphan', '<harness>user file</harness>')]));
  expect(literal[0]?.output).toBe('<harness>user file</harness>');
});

test('live and nested progress attach to their durable calls, while missing results never become success', () => {
  const value = view([call(1, 'parent', 'bash', { command: 'run' })], {
    tools: [{ callId: 'parent', name: 'bash', status: 'running', taskId: 20, output: 'live' }],
    nestedTools: [{ callId: 'parent/child', name: 'read', status: 'done', taskId: 21, parentTaskId: 20, arguments: { path: 'src/a.ts' }, summary: { isError: true, error: 'missing file', durationMs: 2 } }],
  });
  const projected = tools(value);
  expect(projected).toHaveLength(1); expect(projected[0]?.status).toBe('running');
  expect(projected[0]?.children[0]?.status).toBe('error'); expect(projected[0]?.children[0]?.output).toBe('missing file');
  expect(tools(view([call(1, 'lost', 'write', { path: 'a', content: 'b' })]))[0]?.status).toBe('interrupted');
});

test('partial tool-call argument JSON is not assistant prose, and image payloads are not materialized into output', () => {
  const partial = view([], { run: { taskId: 10 }, generation: { message: { role: 'assistant', content: [{ type: 'text', text: 'Reading…' }, { type: 'toolCall', id: 'partial', name: 'read', arguments: { path: '<script>' } }] } } });
  const items = projectTranscript(partial);
  expect(items).toHaveLength(1); expect(items[0]?.kind).toBe('message');
  const image = result(2, 'image', '');
  image.model[0]!.content = JSON.parse('[{"type":"image","mimeType":"image/png","data":"private-base64"}]');
  const item = tools(view([image]))[0]!;
  expect(item.images).toEqual(['image/png']); expect(JSON.stringify(item)).not.toContain('private-base64');
});

test('display helpers retain SDK argument repairs and correct duration boundaries', () => {
  const item = tools(view([call(1, 'edit', 'edit', { edits: '{invalid', oldText: 'before', newText: 'after' })]))[0]!;
  expect(editsOf(item)).toEqual([{ oldText: 'before', newText: 'after' }]);
  expect(duration(720)).toBe('720ms'); expect(duration(119600)).toBe('2m 0s');
});

test('file language inference does not treat prototype properties as language aliases', () => {
  expect(languageFor('agent.ts')).toBe('typescript');
  expect(languageFor('file.constructor')).toBe('');
  expect(languageFor('file.__proto__')).toBe('');
});

test('reader links cannot invoke native schemes or smuggle credentials, whitespace or nonstandard ports', () => {
  expect(safeHttpsLink('https://example.com/docs?q=ok#section')).toBe('https://example.com/docs?q=ok#section');
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///data/data/io.carmo.mushi/files/home/.mushi/auth.json', 'content://private', 'intent://attack', 'http://example.com', 'https://user:password@example.com', 'https://example.com:444/', 'https://example.com/\nattack']) expect(safeHttpsLink(url)).toBeNull();
});

test('streaming Markdown freezes complete independent blocks, not open fences, lists or reference links', () => {
  expect(stableMarkdownBoundary('Hello.\n\nStill writing')).toBe('Hello.\n\n'.length);
  expect(stableMarkdownBoundary('```js\n[1,2]\n\n')).toBe(0);
  expect(stableMarkdownBoundary('```js\n[1,2]\n```\n\nTail')).toBe('```js\n[1,2]\n```\n\n'.length);
  expect(stableMarkdownBoundary('- one\n\n- two\n\n')).toBe(0);
  expect(stableMarkdownBoundary('[ref]\n\nmore\n\n[ref]: https://example.com\n\n')).toBe(0);
});

test('terminal display handles SGR only and strips OSC clipboard/link commands and cursor controls', () => {
  const data = '\x1b[31mfailed\x1b[0m\n\x1b]52;c;YXR0YWNr\x07safe\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x1b[2J';
  expect(plainTerminal(data)).toBe('failed\nsafelink');
  expect(terminalSegments(data)[0]?.classes).toContain('term-fg-red');
  expect(JSON.stringify(terminalSegments(data))).not.toContain('evil.test');
  expect(plainTerminal('10%\r90%\rdone\r\nnext')).toBe('done\nnext');
});
