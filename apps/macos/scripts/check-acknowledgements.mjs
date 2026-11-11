// Fails when Riffet.app links a library Riffet/Resources/Acknowledgements.md does not list: a Swift
// package from project.yml or Package.resolved, or a library RiffetKit's Kotlin modules declare for
// the code the framework compiles. Transitive Kotlin libraries are listed by hand and not seen here.
//
//   node apps/macos/scripts/check-acknowledgements.mjs [Package.resolved]
//
// Package.resolved lives in the generated, untracked Riffet.xcodeproj; without the argument it is
// read when present.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const macos = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = resolve(macos, '../mobile');
const read = path => readFileSync(path, 'utf8');
const identity = url => url.replace(/\/$/, '').replace(/\.git$/, '').split('/').pop().toLowerCase();

const acknowledgements = read(join(macos, 'Riffet/Resources/Acknowledgements.md'));
const patterns = [...acknowledgements.matchAll(/^\|[^|]*\|\s*`([^`]+)`/gm)]
  .map(([, id]) => new RegExp(`^${id.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
const listed = id => patterns.some(pattern => pattern.test(id));

// Every `Licenses/<file>` the table names must actually ship in the bundle's Licenses folder.
const referencedTexts = [...new Set([...acknowledgements.matchAll(/`(Licenses\/[^`\s]+)`/g)].map(([, file]) => file))];
const missingTexts = referencedTexts.filter(file => !existsSync(join(macos, 'Riffet/Resources', file)));

const swift = new Map();
const project = read(join(macos, 'project.yml'));
const packages = /^packages:\n((?:[ \t]+.*\n|\n)*)/m.exec(project)?.[1] ?? '';
for (const [, url] of packages.matchAll(/^\s+url:\s*(\S+)/gm)) swift.set(identity(url), 'project.yml');
const resolvedPath = process.argv[2] ? resolve(process.argv[2]) : join(macos, 'Riffet.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved');
if (process.argv[2] || existsSync(resolvedPath)) {
  for (const pin of JSON.parse(read(resolvedPath)).pins) swift.set(pin.identity, 'Package.resolved');
}

// The source sets that end up in the macosArm64 framework, of :client and the projects it depends on.
const catalog = new Map();
const libraries = /^\[libraries\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(read(join(mobile, 'gradle/libs.versions.toml')))?.[1] ?? '';
for (const [, alias, module] of libraries.matchAll(/^([\w-]+)\s*=\s*\{[^}]*module\s*=\s*"([^"]+)"/gm)) catalog.set(alias.replace(/[-_]/g, '.'), module);
const kotlin = new Map();
const modules = ['client'];
for (const name of modules) {
  const script = read(join(mobile, name, 'build.gradle.kts'));
  for (const match of script.matchAll(/\b(common|apple|native|macos|macosArm64)Main\.dependencies\s*\{/g)) {
    let depth = 1, end = match.index + match[0].length;
    while (depth && end < script.length) depth += { '{': 1, '}': -1 }[script[end++]] ?? 0;
    const block = script.slice(match.index, end).replace(/\/\/.*$/gm, '');
    for (const [, project] of block.matchAll(/project\(":([\w-]+)"\)/g)) if (!modules.includes(project)) modules.push(project);
    for (const [, alias] of block.matchAll(/\blibs\.([\w.]+)/g)) {
      const module = catalog.get(alias);
      if (!module) throw new Error(`${name}/build.gradle.kts uses libs.${alias}, which libs.versions.toml does not define`);
      kotlin.set(module, `${name}/build.gradle.kts`);
    }
  }
}

const missing = [...swift, ...kotlin].filter(([id]) => !listed(id));
if (missing.length) {
  console.error(`Riffet/Resources/Acknowledgements.md does not list:\n${missing.map(([id, source]) => `  ${id} (${source})`).join('\n')}`);
  process.exit(1);
}
if (missingTexts.length) {
  console.error(`Riffet/Resources/Acknowledgements.md names license texts that do not exist:\n${missingTexts.map(file => `  ${file}`).join('\n')}`);
  process.exit(1);
}
console.log(`acknowledgements: ${swift.size} Swift packages and ${kotlin.size} Kotlin libraries listed, ${referencedTexts.length} license texts present`);
