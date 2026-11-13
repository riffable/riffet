// Builds the Sparkle feed the Mac app reads (RIFFET_APPCAST_URL in apps/macos/project.yml) from the
// published GitHub releases, so deploying the site never loses an entry (docs/RELEASE.md, "macOS updates").
//
//   tsx scripts/build-appcast.ts <site dir>     writes <site dir>/appcast.xml
//
// A release contributes an item when it carries Riffet-<version>.appcast.json, written and signed by
// apps/macos/scripts/release.sh next to the Riffet-<version>.zip it describes. A prerelease is a beta:
// its item is in the `beta` channel, which only apps that allow it see. Release notes come from the
// release body, which scripts/release.mjs writes as the English notes followed by one
// <details><summary>LANGUAGE</summary> block per translation; each becomes a localized description.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const repository = process.env.GITHUB_REPOSITORY ?? 'riffable/riffet';
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
/** Sparkle only needs the newest item a Mac may take; older ones are kept for a while for older macOS versions. */
const KEEP = 20;
const LANGUAGES: Record<string, string> = { '简体中文': 'zh-Hans' };

interface Asset { name: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null; body: string | null; html_url: string; assets: Asset[] }
interface Entry { version: string; shortVersion: string; build: string; minimumSystemVersion: string; file: string; length: number; edSignature: string }

async function github<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return await response.json() as T;
}

function entryOf(value: unknown, name: string): Entry {
  const entry = value as Partial<Entry>;
  const text = (key: keyof Entry) => typeof entry[key] === 'string' && entry[key] !== '';
  if (!text('version') || !text('shortVersion') || !/^\d+$/.test(String(entry.build)) || !text('minimumSystemVersion')
    || !text('file') || !Number.isSafeInteger(entry.length) || !text('edSignature')) throw new Error(`${name}: incomplete appcast entry`);
  return entry as Entry;
}

/** { 'en': markdown, 'zh-Hans': markdown, … } from a release body written by scripts/release.mjs. */
function notesOf(body: string): Record<string, string> {
  const blocks = /<details>\s*<summary>([^<]+)<\/summary>([\s\S]*?)<\/details>/g;
  const notes: Record<string, string> = { en: body.replace(blocks, '').trim() };
  for (const [, label, text] of body.matchAll(blocks)) {
    const language = LANGUAGES[label.trim()];
    if (language) notes[language] = text.trim();
  }
  return notes;
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Raw HTML in the notes is dropped (react-markdown's default), so the CDATA only ever holds rendered Markdown.
const html = (markdown: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, markdown)).replaceAll(']]>', ']]&gt;');

function item(release: Release, entry: Entry, url: string): string {
  const notes = notesOf(release.body ?? '');
  const descriptions = Object.entries(notes).filter(([, text]) => text)
    .map(([language, text]) => `      <description xml:lang="${language}"><![CDATA[${html(text)}]]></description>`);
  return [
    '    <item>',
    `      <title>Riffet ${escape(entry.version)}</title>`,
    `      <pubDate>${new Date(release.published_at!).toUTCString()}</pubDate>`,
    `      <link>${escape(release.html_url)}</link>`,
    `      <sparkle:version>${escape(entry.build)}</sparkle:version>`,
    `      <sparkle:shortVersionString>${escape(entry.version)}</sparkle:shortVersionString>`,
    `      <sparkle:minimumSystemVersion>${escape(entry.minimumSystemVersion)}</sparkle:minimumSystemVersion>`,
    ...(release.prerelease ? ['      <sparkle:channel>beta</sparkle:channel>'] : []),
    ...descriptions,
    `      <enclosure url="${escape(url)}" length="${entry.length}" type="application/octet-stream" sparkle:edSignature="${escape(entry.edSignature)}"/>`,
    '    </item>',
  ].join('\n');
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out || process.argv.length !== 3) throw new Error('usage: tsx scripts/build-appcast.ts <site dir>');
  const releases = await github<Release[]>(`https://api.github.com/repos/${repository}/releases?per_page=100`);
  const items: Array<{ build: number; xml: string }> = [];
  for (const release of releases) {
    if (release.draft || !release.published_at) continue;
    const sidecar = release.assets.find(({ name }) => name.endsWith('.appcast.json'));
    if (!sidecar) continue;
    const entry = entryOf(await github<unknown>(sidecar.browser_download_url), `${release.tag_name}/${sidecar.name}`);
    const archive = release.assets.find(({ name }) => name === entry.file);
    if (!archive) throw new Error(`${release.tag_name}: ${sidecar.name} names ${entry.file}, which the release does not carry`);
    items.push({ build: Number(entry.build), xml: item(release, entry, archive.browser_download_url) });
  }
  items.sort((a, b) => b.build - a.build);
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">',
    '  <channel>',
    '    <title>Riffet</title>',
    `    <link>https://github.com/${repository}/releases</link>`,
    ...items.slice(0, KEEP).map(({ xml }) => xml),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
  await mkdir(resolve(out), { recursive: true });
  await writeFile(join(resolve(out), 'appcast.xml'), xml);
  console.log(`${out}/appcast.xml: ${Math.min(items.length, KEEP)} items`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
