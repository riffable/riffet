import { redactSensitiveText } from '../settings/config-documents.js';

export function markdownDescription(content: string): { name?: string; description?: string; alwaysApply?: boolean; patterns?: string[]; hasFrontmatter?: boolean; invalidFrontmatter?: boolean } {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n') && normalized !== '---') return {};
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return { invalidFrontmatter: true };
  const front = normalized.slice(4, end).split('\n');
  let name: string | undefined;
  let description: string | undefined;
  let alwaysApply: boolean | undefined;
  const patterns: string[] = [];
  let listKey: 'globs' | 'paths' | undefined;
  const clean = (raw: string) => {
    const trimmed = raw.trim();
    return trimmed.replace(/^(?:"(.*)"|'(.*)')$/, (_all, double?: string, single?: string) => double ?? single ?? '').trim();
  };
  const splitTopLevelCommas = (input: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    let braceDepth = 0;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!;
      if (quote) {
        if (ch === quote && input[i - 1] !== '\\') quote = undefined;
        current += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === '{') {
        braceDepth++;
        current += ch;
      } else if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        current += ch;
      } else if (ch === ',' && braceDepth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    parts.push(current);
    return parts;
  };
  const pushPatterns = (raw: string, splitCommas = true) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const isBracketed = trimmed.startsWith('[') && trimmed.endsWith(']');
    const inner = isBracketed ? trimmed.slice(1, -1) : trimmed;
    const segments = isBracketed || splitCommas ? splitTopLevelCommas(inner) : [inner];
    for (const part of segments) {
      const item = clean(part);
      if (item && !patterns.includes(item)) patterns.push(redactSensitiveText(item));
    }
  };
  for (const line of front) {
    if (listKey) {
      const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/);
      if (itemMatch) { pushPatterns(itemMatch[1]!, false); continue; }
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
      listKey = undefined;
    }
    const match = line.match(/^\s*(name|description|alwaysApply|globs|paths)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const rawValue = match[2]!.trim();
    const value = clean(rawValue);
    if (key === 'name') { if (value) name = redactSensitiveText(value); }
    else if (key === 'description') { if (value) description = redactSensitiveText(value); }
    else if (key === 'alwaysapply') {
      if (/^(?:true|yes|1)$/i.test(value)) alwaysApply = true;
      else if (/^(?:false|no|0)$/i.test(value)) alwaysApply = false;
    } else if (key === 'globs' || key === 'paths') {
      if (rawValue) pushPatterns(rawValue, true);
      else listKey = key;
    }
  }
  return {
    hasFrontmatter: true,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(alwaysApply !== undefined ? { alwaysApply } : {}),
    ...(patterns.length ? { patterns } : {}),
  };
}

export function markdownSummary(content: string): string | undefined {
  let body = content.replace(/\r\n/g, '\n');
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) body = body.slice(end + 4);
  }
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  let inFence = false;
  let heading: string | undefined;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (/^(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || !line || /^(?:---|\*\*\*|___|\|[\s:-]+\|)$/.test(line)) continue;
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      heading ??= redactSensitiveText(headingMatch[1]!.trim());
      continue;
    }
    const cleaned = redactSensitiveText(line.replace(/^(?:[-*+]\s+|\d+\.\s+|>\s+)/, '').trim());
    if (!cleaned) continue;
    return heading ? `${heading} · ${cleaned}` : cleaned;
  }
  return heading;
}
