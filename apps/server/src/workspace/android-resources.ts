// Android resource references for code navigation: what `R.string.name` or `@layout/name` names, and
// where such resources live. The index side is `symbols/parse-worker.mjs#resourcesOf`.

/** Files in which a resource reference can be followed. */
export const RESOURCE_FILE = new Set(['kt', 'kts', 'java', 'xml']);
const RESOURCE_TYPES = new Set(['anim', 'animator', 'array', 'attr', 'bool', 'color', 'dimen', 'drawable', 'font', 'fraction', 'id', 'integer', 'interpolator', 'layout', 'menu', 'mipmap', 'navigation', 'plurals', 'raw', 'string', 'style', 'styleable', 'transition', 'xml']);
export interface ResourceReference { type: string; name: string }

/**
 * The resource a cursor on `word` names, from the text around it: `R.<type>.word` (any qualifier but
 * `android.`), or `@type/word`, `@+id/word`, `?attr/word` in an XML file, where a style's name may carry
 * dots (`@style/Theme.App`) and so continues after the word. `'system'` for the platform's own resources, which
 * are not in the project; `undefined` when the cursor is on something else.
 */
export function resourceReference(before: string, after: string, word: string): ResourceReference | 'system' | undefined {
  const code = /(?<![\w$])((?:[\w$]+\.)*)R\.([a-z]+)\.$/.exec(before);
  if (code && RESOURCE_TYPES.has(code[2]!)) return code[1]!.endsWith('android.') ? 'system' : { type: code[2]!, name: word };
  const xml = /[@?]\+?(?:([\w.]+):)?([a-z]+)\/([\w.]*)$/.exec(before);
  if (!xml || !RESOURCE_TYPES.has(xml[2]!)) return undefined;
  if (xml[1] === 'android') return 'system';
  return { type: xml[2]!, name: `${xml[3]}${word}${/^[\w.]*/.exec(after)![0].replace(/\.$/, '')}`.replace(/\./g, '_') };
}

/** A file directly in a resource directory: `res/<type>[-qualifiers]/<name>`. */
export const RESOURCE_PATH = /(?:^|\/)res\/([^/]+)\/([^/.][^/]*)$/;
/** The resource type an element of a `values` file declares. */
export const VALUE_TYPES: Record<string, string> = { string: 'string', color: 'color', dimen: 'dimen', style: 'style', integer: 'integer', bool: 'bool', array: 'array', 'string-array': 'array', 'integer-array': 'array', plurals: 'plurals', attr: 'attr', 'declare-styleable': 'styleable', drawable: 'drawable', fraction: 'fraction' };
