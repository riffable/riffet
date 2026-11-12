// The one source of private words for check-public-artifacts.mjs and check-privacy.mjs:
// - `RIFFET_EXCLUDED_VENDORS`: comma-separated vendors; each contributes `plugins/<vendor>/`;
// - `RIFFET_ARTIFACT_DENYLIST`: comma-separated markers;
// - `RIFFET_ARTIFACT_DENYLIST_FILE`: one marker per line (keep it out of version control);
// - `~/.config/riffet/private-words.txt`, read when present (override the path with `RIFFET_PRIVATE_WORDS_FILE`).
// Blank lines and lines starting with `#` in files are ignored. Matching is case-insensitive.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const fileMarkers = path => readFileSync(path, 'utf8').split('\n').filter(line => !line.trim().startsWith('#'));

// Throws an Error with a user-facing message when a named file is missing.
export function loadMarkers(env = process.env) {
  const listed = env.RIFFET_ARTIFACT_DENYLIST_FILE;
  if (listed && !existsSync(listed)) throw new Error(`RIFFET_ARTIFACT_DENYLIST_FILE ${listed} does not exist.`);
  const local = env.RIFFET_PRIVATE_WORDS_FILE ?? join(homedir(), '.config', 'riffet', 'private-words.txt');
  if (env.RIFFET_PRIVATE_WORDS_FILE && !existsSync(local)) throw new Error(`RIFFET_PRIVATE_WORDS_FILE ${local} does not exist.`);
  return [...new Set([
    ...(env.RIFFET_EXCLUDED_VENDORS ?? '').split(',').map(vendor => vendor.trim()).filter(Boolean).map(vendor => `plugins/${vendor}/`),
    ...(env.RIFFET_ARTIFACT_DENYLIST ?? '').split(','),
    ...(listed ? fileMarkers(listed) : []),
    ...(existsSync(local) ? fileMarkers(local) : []),
  ].map(marker => marker.trim()).filter(Boolean))];
}

export const markerPattern = marker => new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
