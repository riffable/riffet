#!/usr/bin/env node
// Fails when a build still carries a marker from a deny-list, such as a vendor left out by
// `RIFFET_EXCLUDED_VENDORS` (docs/PLUGIN_ARCHITECTURE.md). Run it after the excluded build:
//
//   RIFFET_EXCLUDED_VENDORS=acme pnpm build
//   RIFFET_ARTIFACT_DENYLIST='acme.example,plugins/acme/' pnpm check:public-artifacts
//   pnpm check:public-artifacts dist apps/macos/build/server-payload
//
// Each excluded vendor's `plugins/<vendor>/` path is always a marker. Further markers are
// comma-separated in `RIFFET_ARTIFACT_DENYLIST`, and one per line in the file named by
// `RIFFET_ARTIFACT_DENYLIST_FILE` (keep that file out of version control). A hit means code from
// an excluded vendor, a source map path or a copied asset still reached the artifacts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const targets = (process.argv.length > 2 ? process.argv.slice(2) : [join(root, 'dist')])
  .map(target => resolve(target));

const listed = process.env.RIFFET_ARTIFACT_DENYLIST_FILE;
if (listed && !existsSync(listed)) {
  console.error(`RIFFET_ARTIFACT_DENYLIST_FILE ${listed} does not exist.`);
  process.exit(2);
}
const markers = [
  // A vendor left out of the build must not leave its source path in a bundle or source map.
  ...(process.env.RIFFET_EXCLUDED_VENDORS ?? '').split(',').map(vendor => vendor.trim()).filter(Boolean).map(vendor => `plugins/${vendor}/`),
  ...(process.env.RIFFET_ARTIFACT_DENYLIST ?? '').split(','),
  ...(listed ? readFileSync(listed, 'utf8').split('\n') : []),
].map(marker => marker.trim()).filter(Boolean);
if (!markers.length) {
  console.error('No markers: set RIFFET_EXCLUDED_VENDORS, RIFFET_ARTIFACT_DENYLIST or RIFFET_ARTIFACT_DENYLIST_FILE.');
  process.exit(2);
}
const patterns = markers.map(marker => ({ marker, pattern: new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

const hits = [];
for (const target of targets) {
  const info = statSync(target, { throwIfNoEntry: false });
  if (!info) {
    console.error(`No build at ${relative(root, target)}; run pnpm build first.`);
    process.exit(2);
  }
  for (const file of info.isDirectory() ? files(target) : [target]) {
    // latin1 maps every byte to one character, so binaries (the bundled node runtime, .node
    // modules) are scanned without failing on invalid UTF-8 or shifting line counts.
    const text = readFileSync(file).toString('latin1');
    for (const { marker, pattern } of patterns) {
      const match = pattern.exec(text);
      if (match) hits.push(`${relative(root, file)}:${text.slice(0, match.index).split('\n').length} (${marker})`);
    }
  }
}

if (hits.length) {
  console.error(`Denied markers remain:\n${hits.map(hit => `  ${hit}`).join('\n')}`);
  process.exit(1);
}
console.log(`No denied markers in ${targets.map(target => relative(root, target)).join(', ')}.`);
