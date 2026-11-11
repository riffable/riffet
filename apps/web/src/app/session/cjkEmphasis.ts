import { transformProse } from './markdownSource';

/**
 * Han, kana, Hangul and the full-width forms beside them — the characters CommonMark's flanking
 * rules do not know are "letters", so a run right against them reads as both-sided.
 */
const CJK = /[⺀-鿿぀-ヿ가-힯豈-﫿︰-﹏＀-￯]/;
/**
 * A paired `_` run with a letter on both outside edges, the shape Chinese prose gives emphasis
 * (`__加粗__中文`). The run itself is captured so the pair can be rebuilt with asterisks.
 */
const PAIR = /(^|[^A-Za-z0-9_])(_{1,3})(\S(?:.*?\S)?)\2(?=$|[^A-Za-z0-9_])/g;

/**
 * CommonMark lets `_` open and close only where it is not surrounded by word characters, which in
 * Chinese is every `_…_` next to a Han character: `__加粗__中文` and `_斜体_中文` stay literal.
 * `**` has no such rule and `remark-cjk-friendly` relaxes the one it has, so the same emphasis
 * written with asterisks renders. Rewriting a paired run to asterisks gives `_` the same reading.
 *
 * Only a run whose text is Chinese is treated as emphasis: `调用__init__方法` and
 * `文档 _config_说明.md` are identifiers and file names, where the underscores are the point.
 */
export function relaxUnderscoreEmphasis(markdown: string): string {
  if (!markdown.includes('_')) return markdown;
  return transformProse(markdown, (text) => {
    if (!text.includes('_')) return text;
    return text.replace(PAIR, (match, before: string, run: string, content: string, offset: number) => {
      if (!CJK.test(content)) return match;
      // A path can hold underscores; its text is not prose emphasis.
      if (/https?:\/\/\S*$/.test(text.slice(0, offset))) return match;
      const stars = '*'.repeat(run.length);
      return `${before}${stars}${content}${stars}`;
    });
  });
}
