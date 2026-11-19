import type { FileEntry } from '@contracts';
import {
  IconArchive, IconFile, IconFileCode2, IconFileCog, IconFileText, IconFolder,
  IconGlobe, IconImage, IconLanguages, IconPackage, IconSquareTerminal,
} from '@/components/icons';
import { cn } from '@/lib/utils';

const imageExt = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|heic|icns|tiff?)$/i;
const localeExt = /\.(po|pot|strings|xcstrings|xliff)$/i;
const webExt = /\.(html?|xhtml)$/i;
const shellExt = /\.(sh|zsh|bash|fish|ps1|bat|cmd)$/i;
const shellName = /^(dockerfile(\..*)?|makefile|justfile|cmakelists\.txt|procfile)$/i;
const configExt = /\.(json|jsonc|json5|ya?ml|toml|xml|plist|lock|ini|cfg|conf|env|properties|entitlements|pbxproj)$/i;
const configName = /^\.(gitignore|gitattributes|gitmodules|editorconfig|npmrc|nvmrc|prettierrc|eslintrc|env(\..*)?)$/i;
const docExt = /\.(md|markdown|mdown|mkd|mdx|mdc|txt|rtf|rst|adoc|pdf|log|csv|tsv)$/i;
const archiveExt = /\.(zip|tar|gz|tgz|xz|bz2|7z|dmg|pkg)$/i;
const packageExt = /\.(apk|ipa|aab|whl|jar|wasm)$/i;
const codeExt = /\.(tsx?|jsx?|mjs|cjs|mts|cts|py|pyi|go|rs|java|kt|kts|gradle|swift|c|cc|cpp|cxx|h|hpp|m|mm|rb|php|cs|dart|vue|svelte|astro|css|scss|sass|less|sql|proto|graphql|gql|lua|r|scala|zig|ex|exs)$/i;

export function FileIcon({ entry, className }: { entry: Pick<FileEntry, 'kind' | 'name'>; className?: string }) {
  if (entry.kind === 'directory') return <IconFolder className={cn('size-4 shrink-0 text-fg-3', className)} />;
  const iconClass = cn('size-4 shrink-0 text-fg-4', className);
  const { name } = entry;
  if (imageExt.test(name)) return <IconImage className={iconClass} />;
  if (localeExt.test(name)) return <IconLanguages className={iconClass} />;
  if (webExt.test(name)) return <IconGlobe className={iconClass} />;
  if (shellName.test(name) || shellExt.test(name)) return <IconSquareTerminal className={iconClass} />;
  if (configName.test(name) || configExt.test(name)) return <IconFileCog className={iconClass} />;
  if (docExt.test(name)) return <IconFileText className={iconClass} />;
  if (archiveExt.test(name)) return <IconArchive className={iconClass} />;
  if (packageExt.test(name)) return <IconPackage className={iconClass} />;
  if (codeExt.test(name)) return <IconFileCode2 className={iconClass} />;
  return <IconFile className={iconClass} />;
}

export const splitPath = (path: string) => { const at = path.lastIndexOf('/'); return { name: path.slice(at + 1), dir: at < 0 ? '' : path.slice(0, at) }; };

/** `text` with the part that `query`'s name part names in it set apart, when it is one run. */
export function Matched({ text, query }: { text: string; query: string }) {
  const needle = query.trim().split('/').pop()?.toLowerCase() ?? '';
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<span className="font-medium text-fg">{text.slice(at, at + needle.length)}</span>{text.slice(at + needle.length)}</>;
}

/** A directory cut at its start: its last folders tell same-named files apart. */
export function DirectoryHint({ dir, className }: { dir: string; className?: string }) {
  return <span className={cn('min-w-0 truncate text-left font-mono text-2xs text-fg-3 [direction:rtl]', className)}><bdi>{dir}</bdi></span>;
}
