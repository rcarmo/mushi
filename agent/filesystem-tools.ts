import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { getOrThrow, type FileInfo, type FileListEntry } from '@earendil-works/pi-durable/env';
import type { Context } from '@earendil-works/chord';
import ignore, { type Ignore } from 'ignore';

const result = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredOutput: JSON.parse(JSON.stringify(value)) });
const pathSchema = Type.Optional(Type.String({ description: 'Relative or absolute path; default current workspace' }));
const hiddenSchema = Type.Optional(Type.Boolean({ description: 'Include dotfiles (default true); .git is always excluded from recursive searches' }));
function envOf(api: ToolExecutionApi) {
  if (!api.env) throw new Error('No filesystem environment is configured');
  return api.env;
}
async function listing(api: ToolExecutionApi, path: string, hidden: boolean | undefined, context: Context) {
  const env = envOf(api);
  const absolute = getOrThrow(await env.absolutePath(path, context));
  const info = getOrThrow(await env.fileInfo(absolute, context));
  if (info.kind === 'file') return { absolute, entries: [{ path: '', kind: 'file' }] as FileListEntry[], truncated: false };
  if (env.listFiles) return { absolute, ...getOrThrow(await env.listFiles(absolute, {
    hidden: hidden ?? true, gitignore: true, exclude: ['node_modules'], maxEntries: 10_000, maxBytes: 1024 * 1024, timeoutMs: 10_000,
  }, context)) };
  // NodeExecutionEnv 1.3 does not implement optional listFiles(). Walk through
  // bounded readers instead; never shell out, follow links or read whole trees.
  const entries: FileListEntry[] = [];
  const started = Date.now();
  let bytes = 0, ignoreBytes = 0, visited = 0, truncated = false;
  type Rules = { base: string; rules: Ignore }[];
  async function walk(directory: string, prefix: string, inherited: Rules, depth: number) {
    context.abortSignal?.throwIfAborted();
    if (depth > 64 || Date.now() - started > 10_000) { truncated = true; return; }
    let rules = inherited;
    const ignorePath = getOrThrow(await env.joinPath([directory, '.gitignore'], context));
    const ignored = await env.openBinaryReader(ignorePath, { noFollow: true }, context);
    if (ignored.ok) {
      try {
        const info = getOrThrow(await ignored.value.info(context));
        if (info.size > 64 * 1024 || ignoreBytes + info.size > 256 * 1024) throw new Error('Ignore rules exceed their bounded search budget');
        const content = getOrThrow(await ignored.value.read(0, info.size, context));
        ignoreBytes += content.length;
        rules = [...inherited, { base: prefix, rules: ignore().add(new TextDecoder().decode(content)) }];
      } finally { await ignored.value.close(context); }
    } else if (ignored.error.code !== 'not_found') {
      // Unreadable or symlinked ignore rules must not silently broaden a search.
      throw new Error(`Cannot safely read ignore rules in ${directory}`);
    }
    const opened = await env.openDirReader(directory, context);
    if (!opened.ok) { if (!prefix) throw opened.error; truncated = true; return; }
    const reader = opened.value;
    try {
      let done = false;
      while (!done) {
        context.abortSignal?.throwIfAborted();
        if (visited >= 10_000 || Date.now() - started > 10_000) { truncated = true; break; }
        const page = getOrThrow(await reader.next(Math.min(128, 10_000 - visited), context));
        done = page.done;
        page.entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const item of page.entries) {
          visited++;
          if (item.name === '.git' || item.name === 'node_modules' || (hidden === false && item.name.startsWith('.'))) continue;
          const relative = prefix + item.name;
          let excluded = false;
          for (const scope of rules) {
            const tested = scope.rules.test(relative.slice(scope.base.length) + (item.kind === 'directory' ? '/' : ''));
            if (tested.ignored) excluded = true;
            else if (tested.unignored) excluded = false;
          }
          if (excluded) continue;
          bytes += Buffer.byteLength(relative) + 2;
          if (entries.length >= 10_000 || bytes > 1024 * 1024) { truncated = true; return; }
          entries.push({ path: relative, kind: item.kind });
          if (item.kind === 'directory') await walk(item.path, relative + '/', rules, depth + 1);
          if (visited >= 10_000 || Date.now() - started > 10_000) { truncated = true; return; }
        }
      }
    } finally { await reader.close(context); }
  }
  await walk(absolute, '', [], 0);
  return { absolute, entries, truncated };
}

export const FilesystemTools = defineExtension({ name: 'filesystem', tools: [
  defineTool({
    name: 'ls', description: 'List a directory directly with entry names, kinds, sizes and modification times. Structured results, no shell required. Bounded, sorted returned page; use find for recursive glob matching.',
    parameters: Type.Object({ path: pathSchema, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })), hidden: hiddenSchema }),
    structuredOutputSchema: Type.Unknown(), replay: 'safe',
    async execute(args, api, context) {
      const env = envOf(api), path = getOrThrow(await env.absolutePath(args.path ?? '.', context));
      const reader = getOrThrow(await env.openDirReader(path, context));
      const limit = args.limit ?? 200;
      try {
        const entries: FileInfo[] = [];
        let done = false, visited = 0;
        const started = Date.now();
        while (!done && entries.length <= limit && visited < 10_000 && Date.now() - started < 10_000) {
          const page = getOrThrow(await reader.next(Math.min(256, limit + 1 - entries.length, 10_000 - visited), context));
          done = page.done; visited += page.entries.length;
          entries.push(...page.entries.filter(entry => args.hidden !== false || !entry.name.startsWith('.')));
        }
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        return result({ path, entries: entries.slice(0, limit), truncated: !done || entries.length > limit });
      } finally { await reader.close(context); }
    },
  }),
  defineTool({
    name: 'find', description: 'Find paths by glob relative to a directory (for example **/*.ts). Returns paths and kinds without following symlinks. Respects gitignore, skips .git/node_modules, bounds listing to 10000 entries/1 MiB/10 seconds. Truncation means results are incomplete.',
    parameters: Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 500 }), path: pathSchema, hidden: hiddenSchema,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
    structuredOutputSchema: Type.Unknown(), replay: 'safe',
    async execute(args, api, context) {
      const files = await listing(api, args.path ?? '.', args.hidden, context);
      const glob = new Bun.Glob(args.pattern), limit = args.limit ?? 200;
      const matches = files.entries.filter(entry => glob.match(entry.path));
      return result({ path: files.absolute, matches: matches.slice(0, limit), truncated: files.truncated || matches.length > limit });
    },
  }),
  defineTool({
    name: 'grep', description: 'Search file contents for a literal string (not a regex), returning path, 1-based line and text. Optional case-insensitive matching and relative-path glob. Skips binary files, symlinks and .git/node_modules; respects gitignore. Reads at most 512 KiB/file and 8 MiB total; returns explicit incomplete/truncation counts. No shell or host regex evaluation.',
    parameters: Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 2000 }), path: pathSchema,
      glob: Type.Optional(Type.String({ maxLength: 500 })), ignore_case: Type.Optional(Type.Boolean()), hidden: hiddenSchema,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
    structuredOutputSchema: Type.Unknown(), replay: 'safe',
    async execute(args, api, context) {
      if (args.pattern.includes('\n') || args.pattern.includes('\r')) throw new Error('grep matches one line at a time; pattern must not contain newlines');
      const env = envOf(api), files = await listing(api, args.path ?? '.', args.hidden, context);
      const glob = args.glob ? new Bun.Glob(args.glob) : undefined;
      const needle = args.ignore_case ? args.pattern.toLowerCase() : args.pattern;
      const limit = args.limit ?? 100;
      const matches: { path: string; line: number; text: string; textTruncated: boolean }[] = [];
      let bytes = 0, scanned = 0, skipped = 0, truncated = files.truncated, outputChars = 0;
      const started = Date.now();
      for (const file of files.entries) {
        context.abortSignal?.throwIfAborted();
        if (file.kind !== 'file' || (glob && !glob.match(file.path))) continue;
        if (bytes >= 8 * 1024 * 1024 || Date.now() - started > 10_000) { truncated = true; break; }
        const path = file.path ? getOrThrow(await env.joinPath([files.absolute, file.path], context)) : files.absolute;
        const opened = await env.openBinaryReader(path, { noFollow: true }, context);
        if (!opened.ok) { skipped++; truncated = true; continue; }
        const reader = opened.value;
        try {
          const info = getOrThrow(await reader.info(context));
          const size = Math.min(info.size, 512 * 1024, 8 * 1024 * 1024 - bytes);
          const content = getOrThrow(await reader.read(0, size, context));
          bytes += content.length; scanned++;
          if (content.includes(0)) { skipped++; continue; }
          if (info.size > content.length) truncated = true;
          const lines = new TextDecoder().decode(content).split('\n');
          // Do not report a partial final line as if it was a complete match.
          if (info.size > content.length) lines.pop();
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!.replace(/\r$/, '');
            if (!(args.ignore_case ? line.toLowerCase() : line).includes(needle)) continue;
            const text = line.slice(0, 1000);
            matches.push({ path: file.path || path, line: i + 1, text, textTruncated: line.length > text.length });
            outputChars += text.length;
            if (matches.length >= limit || outputChars >= 64_000) { truncated = true; break; }
          }
        } finally { await reader.close(context); }
        if (matches.length >= limit || outputChars >= 64_000) break;
      }
      return result({ path: files.absolute, matches, filesScanned: scanned, filesSkipped: skipped, bytesRead: bytes, truncated });
    },
  }),
] });
