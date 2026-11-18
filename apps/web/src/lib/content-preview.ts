import { useMemo } from 'react';
import { useTheme } from './theme';

/** Shared documents receive palette values, never access to the workbench's DOM or storage. */
export function usePreviewTheme(): string {
  const { resolved, themeId, revision } = useTheme();
  return useMemo(() => {
    const params = new URLSearchParams({ scheme: resolved });
    const styles = getComputedStyle(document.documentElement);
    for (const [name, token] of [['color', '--fg'], ['background', '--bg'], ['line', '--line-strong'], ['accent', '--accent']]) {
      params.set(name!, styles.getPropertyValue(token!).trim());
    }
    return params.toString();
  }, [resolved, themeId, revision]);
}

/** The server remains authoritative about which file bytes can be rendered. */
export function mayPreviewFile(name: string, mimeType?: string): boolean {
  return /\.(?:md|markdown|mdown|mkd|mdx|mdc|html?|xhtml|svg|ico|tiff?|heic|heif|pdf|docx?|docm|dotx?|odt|ott|rtf|tex|latex|ltx|xlsx?|xlsm|xlsb|xltx?|xltm|ods|ots|numbers|pages|pptx?|pptm|ppsx?|potx?|odp|otp|odg|otg|key|csv|tsv|json|jsonl|ndjson|ya?ml|xml|toml|ipynb|mmd|mermaid|dot|gv|puml|plantuml|wsd|d2|vega|vl|mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|webm|mov|m4v|ogv|zip|jar|war|apk|ipa|tar|tgz|gz|gzip|sqlite3?|db3?|glb|gltf|obj|stl|ply|epub|ttf|otf|woff2?)$/i.test(name)
    || /^(?:audio\/|video\/|application\/(?:pdf|json|xml|epub\+zip)|text\/)/i.test(mimeType ?? '');
}
