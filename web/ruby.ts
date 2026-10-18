import type MarkdownIt from 'markdown-it';

export interface RubyReading { base: string; reading: string; length: number }
/** Readings are text only. Arbitrary HTML, attributes and nested elements are
 * never accepted. The compact notation also works with raw HTML disabled. */
export function rubyAt(source: string): RubyReading | null {
  const compact = source.match(/^\{([^{}|\r\n]{1,80})\|([^{}|\r\n]{1,120})\}/u);
  if (compact) return { base: compact[1]!, reading: compact[2]!, length: compact[0].length };
  const html = source.match(/^<ruby>([^<>\r\n]{1,80})(?:<rp>[（(]<\/rp>)?<rt>([^<>\r\n]{1,120})<\/rt>(?:<rp>[）)]<\/rp>)?<\/ruby>/iu);
  return html ? { base: html[1]!, reading: html[2]!, length: html[0].length } : null;
}
export function installRuby(markdown: MarkdownIt) {
  markdown.inline.ruler.before('text', 'mushi_ruby', (state, silent) => {
    if (state.src[state.pos] !== '{' && state.src[state.pos] !== '<') return false;
    const annotation = rubyAt(state.src.slice(state.pos));
    if (!annotation) return false;
    if (!silent) {
      const token = state.push('ruby_annotation', 'ruby', 0);
      token.meta = { base: annotation.base, reading: annotation.reading };
      token.content = annotation.base;
    }
    state.pos += annotation.length;
    return true;
  });
}
