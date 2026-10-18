import { expect, test } from 'bun:test';
import MarkdownIt from 'markdown-it';
import { installRuby, rubyAt } from '../web/ruby.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openAgent } from '../agent/harness.ts';

test('ruby annotations accept compact readings and text-only ruby, not HTML attributes/elements', () => {
  expect(rubyAt('{日本語|にほんご}です。')).toEqual({ base: '日本語', reading: 'にほんご', length: '{日本語|にほんご}'.length });
  expect(rubyAt('<ruby>漢字<rt>kanji</rt></ruby>')?.reading).toBe('kanji');
  expect(rubyAt('<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>')?.base).toBe('漢字');
  for (const value of ['<ruby onclick="attack()">漢字<rt>x</rt></ruby>', '<ruby><img src=x><rt>x</rt></ruby>', '<ruby>字<rt><script>x</script></rt></ruby>', '{字|かん\nじ}']) expect(rubyAt(value)).toBeNull();
});

test('ruby parsing does not transliterate code, commands or paths', () => {
  const markdown = new MarkdownIt({ html: false }); installRuby(markdown);
  const tokens = markdown.parse('これは{日本語|にほんご}です。\n\nRomaji: Kore wa nihongo desu.\n\n`{コード|code}`\n\n```sh\necho "{文字|moji}"\n```', {});
  const annotations = tokens.flatMap(token => token.children ?? []).filter(token => token.type === 'ruby_annotation');
  expect(annotations).toHaveLength(1); expect(annotations[0]?.meta).toEqual({ base: '日本語', reading: 'にほんご' });
  expect(tokens.find(token => token.type === 'fence')?.content).toBe('echo "{文字|moji}"\n');
  expect(tokens.flatMap(token => token.children ?? []).find(token => token.type === 'code_inline')?.content).toBe('{コード|code}');
});

test('Mushi supplies Japanese/romaji/ruby communication instructions to its actual harness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-japanese-'));
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{準備|じゅんび}ができました。\n\nJunbi ga dekimashita.')]);
  const agent = await openAgent(directory, models, { provider: 'faux', modelId: 'faux-1' });
  try {
    await (await agent.conversation.submit({ type: 'input', content: 'jumbi ga dekimashita ka?' }, ctx)).wait(ctx);
    const messages = (await agent.conversation.context(ctx)).messages;
    const systems = messages.filter(message => message.role === 'system');
    const text = JSON.stringify(systems);
    expect(text).toContain('Mushi'); expect(text).toContain('natural Japanese'); expect(text).toContain('Hepburn romaji');
    expect(text).toContain('{漢字|かんじ}'); expect(text).toContain('code, commands, paths');
    expect(text).toContain('unlabeled line'); expect(text).not.toContain('Romaji:');
  } finally { await agent.close(); await rm(directory, { recursive: true, force: true }); }
});
