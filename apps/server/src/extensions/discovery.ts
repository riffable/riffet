import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionCreateTarget, ExtensionDetail, ExtensionItem, ExtensionKind, ExtensionScope } from '../../../../packages/contracts/src/extensions.js';
import { AppError } from '../errors.js';
import { assertWithin, isWithin } from '../workspace/scope.js';
import { redactSensitiveText } from '../settings/config-documents.js';
import { markdownDescription, markdownSummary } from './discovery-markdown.js';
import {
  MANIFEST_DIRECTORY, MAX_SCAN_DEPTH, applyEffect, builtinSkillPath, configTargets, createTargetDocumentDescriptor,
  createTargetList, displayPath, errMessage, hasSymlinkAncestor, isMarkdown, isSkill, languageFor, managedPath,
  markdownDirectories, normalizeItemName, pluginDirectories, pluginManifest, readCandidate, record, scanFiles,
  sha, skillIdentityPath, sourceRoots, text, userRootFor,
  type PluginRoot, type SourceRoot,
} from './discovery-paths.js';
import { riffetSkillEntries, scopeInEffect } from './riffet-skills.js';
import { readSkillSettings } from './skill-settings.js';
import type { ExtensionContext, ExtensionDocumentDescriptor, ExtensionSnapshot } from './types.js';

export { createTargetDocumentDescriptor, userRootFor };

export async function discoverExtensions(ctx: ExtensionContext): Promise<ExtensionSnapshot> {
  if (ctx.profile.backendId !== ctx.backendId) throw new AppError('EXTENSION_BACKEND_MISMATCH', 'Extension backend and profile do not match', 400);
  const diagnostics: string[] = [];
  const sources = await sourceRoots(ctx, diagnostics);
  const skillSettings = ['claude', 'droid'].includes(ctx.backendId)
    ? await readSkillSettings(ctx, sources.find(source => source.scope === 'user' && source.role === 'agent')!.root)
    : undefined;
  const docs = new Map<string, ExtensionDocumentDescriptor>();
  const items = new Map<string, ExtensionItem>();
  const details = new Map<string, ExtensionDetail>();
  const createTargets = new Map<string, { contract: ExtensionCreateTarget; root: string }>();
  const pluginRoots: PluginRoot[] = [];
  const configFiles: Array<{ source: SourceRoot; absolute: string; relative: string; descriptor: ExtensionDocumentDescriptor; kind: ExtensionKind; content: string }> = [];
  const realRoots = new Map<string, string>();
  const resolveRealRoot = async (root: string): Promise<string> => {
    const cached = realRoots.get(root);
    if (cached !== undefined) return cached;
    const resolved = await realpath(root);
    realRoots.set(root, resolved);
    return resolved;
  };
  const symlinkDirs = new Map<string, boolean>();
  const dirHasSymlinkAncestor = async (root: string, directory: string): Promise<boolean> => {
    const key = `${root}\0${directory}`;
    const cached = symlinkDirs.get(key);
    if (cached !== undefined) return cached;
    const result = await hasSymlinkAncestor(root, directory);
    symlinkDirs.set(key, result);
    return result;
  };

  const itemId = (scope: ExtensionScope, kind: ExtensionKind, absolutePath: string, suffix = ''): string => sha([ctx.backendId, ctx.profile.id, scope, absolutePath, kind, suffix].join('\0')).slice(0, 40);
  const fileDescriptor = (source: SourceRoot, absolute: string, relative: string, scope: ExtensionScope, kind: ExtensionKind, symlink = false): ExtensionDocumentDescriptor => {
    const id = sha([ctx.backendId, ctx.profile.id, scope, source.root, kind === 'skill' ? skillIdentityPath(relative) : relative, kind].join('\0')).slice(0, 40);
    const managed = scope === 'managed' || managedPath(relative, ctx.backendId);
    const effectiveScope: ExtensionScope = managed ? 'managed' : scope;
    const reason = symlink ? '共享链接的内容只读，不能在此删除链接目标。' : scope === 'builtin' ? 'Agent 内置 Skill，随 Agent 安装维护。' : managed ? '此文件由 Agent 或所属插件维护。' : undefined;
    return {
      id,
      path: displayPath(source.root, absolute, source.scope),
      absolutePath: absolute,
      relativePath: relative,
      root: source.root,
      scope: effectiveScope,
      language: kind === 'skill' && isSkill(path.basename(absolute)) ? 'markdown' : languageFor(absolute),
      editable: !reason && (scope === 'project' || scope === 'user'),
      ...(reason ? { reason } : {}),
      applyEffect: applyEffect(ctx),
    };
  };
  const addDoc = (source: SourceRoot, absolute: string, relative: string, kind: ExtensionKind, symlink = false): ExtensionDocumentDescriptor => {
    const scope: ExtensionScope = builtinSkillPath(relative) ? 'builtin' : symlink || managedPath(relative, ctx.backendId) ? 'managed' : source.scope;
    const probe = fileDescriptor(source, absolute, relative, scope, kind, symlink);
    const existing = docs.get(probe.id);
    if (existing) return existing;
    docs.set(probe.id, probe);
    return probe;
  };
  const addItem = (item: ExtensionItem, files: ExtensionDocumentDescriptor[] = []): void => {
    if (items.has(item.id)) return;
    items.set(item.id, item);
    const unique = new Map(files.map(file => [file.id, file]));
    details.set(item.id, { item, files: [...unique.values()].map(({ id, path: filePath, editable, reason }) => ({ id, path: filePath, editable, ...(reason ? { reason } : {}) })) });
  };
  const ownerFor = (source: SourceRoot, relative: string): string | undefined => {
    const absolute = path.resolve(source.root, relative);
    const match = pluginRoots.filter(plugin => isWithin(plugin.root, absolute)).sort((a, b) => b.root.length - a.root.length)[0];
    return match?.itemId;
  };

  const addDocumentItem = async (input: { source: SourceRoot; absolute: string; relative: string; kind: ExtensionKind; name: string; description?: string; effectNote?: string; ownerPluginId?: string; nativeId?: string; enabled?: boolean; symlink?: boolean; content?: string }): Promise<ExtensionItem | undefined> => {
    const sourceScope = builtinSkillPath(input.relative) ? 'builtin' : input.symlink || managedPath(input.relative, ctx.backendId) ? 'managed' : input.source.scope;
    const descriptor = addDoc(input.source, input.absolute, input.relative, input.kind, input.symlink);
    let description = input.description;
    let name = input.name;
    if (input.kind === 'skill' && input.content !== undefined) {
      const metadata = markdownDescription(input.content);
      name = metadata.name ?? name;
      description = metadata.description ?? description;
      if (metadata.invalidFrontmatter) diagnostics.push(`Skill metadata has an unterminated frontmatter block: ${descriptor.path}`);
    } else if ((input.kind === 'rule' || input.kind === 'command') && input.content !== undefined) {
      const metadata = markdownDescription(input.content);
      if (metadata.invalidFrontmatter) diagnostics.push(`${input.kind === 'rule' ? 'Rule' : 'Command'} metadata has an unterminated frontmatter block: ${descriptor.path}`);
      const summary = metadata.description ?? markdownSummary(input.content);
      if (input.kind === 'rule') {
        const effect = input.effectNote
          ?? (metadata.patterns?.length ? `匹配 ${metadata.patterns.join(', ')}`
            : metadata.alwaysApply === true ? '常驻生效'
              : metadata.alwaysApply === false ? (metadata.description ? '按需生效' : '手动引用')
                : /\.rules$/i.test(input.relative) ? '命令审批规则'
                  : '常驻生效');
        description = [descriptor.path, effect, summary].filter(Boolean).join(' · ');
      } else {
        description = summary ?? description;
      }
    }
    const id = itemId(sourceScope, input.kind, input.kind === 'skill' ? skillIdentityPath(descriptor.absolutePath) : descriptor.absolutePath, input.nativeId ?? '');
    const item: ExtensionItem = {
      id,
      kind: input.kind,
      name: normalizeItemName(name),
      ...(description ? { description: redactSensitiveText(description).slice(0, 1000) } : {}),
      scope: sourceScope,
      sourcePath: descriptor.path,
      ...(input.ownerPluginId ? { ownerPluginId: input.ownerPluginId } : {}),
      ...(input.nativeId ? { nativeId: input.nativeId } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      runtimeState: 'unknown',
      ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}),
      documentId: descriptor.id,
      ...(input.kind === 'skill' ? { actions: [] } : {}),
    };
    descriptor.itemId = id;
    addItem(item, [descriptor]);
    return item;
  };

  const scanConfig = async (source: SourceRoot): Promise<void> => {
    const seen = new Set<string>();
    for (const candidate of configTargets(ctx, source.scope, source.role)) {
      const absolute = path.resolve(source.root, candidate.relative);
      if (!isWithin(source.root, absolute) || seen.has(absolute)) continue;
      seen.add(absolute);
      let info;
      try { info = await lstat(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
        diagnostics.push(`Cannot inspect extension config ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
        continue;
      }
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      let data: { content: string; raw: Buffer; symlink: boolean };
      try { data = await readCandidate(absolute, source.root); }
      catch (error) {
        diagnostics.push(`Cannot read extension config ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
        continue;
      }
      const relative = path.relative(source.root, absolute);
      const sharedSymlink = info.isSymbolicLink() || await hasSymlinkAncestor(source.root, absolute);
      if (sharedSymlink) diagnostics.push(`Extension config is reached through a shared symlink and is read-only: ${displayPath(source.root, absolute, source.scope)}`);
      const descriptor = addDoc(source, absolute, relative, candidate.kind, sharedSymlink);
      if (source.role === 'claude-global' && relative === '.claude.json') descriptor.projection = 'claudeMcpServers';
      configFiles.push({ source, absolute, relative, descriptor, kind: candidate.kind, content: data.content });
      const name = path.basename(relative);
      const id = itemId(descriptor.scope, 'config', descriptor.absolutePath, candidate.kind);
      const item: ExtensionItem = {
        id, kind: 'config', name, description: descriptor.path,
        scope: descriptor.scope, sourcePath: descriptor.path, runtimeState: 'unknown',
        ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}), documentId: descriptor.id,
      };
      descriptor.itemId ??= id;
      addItem(item, [descriptor]);
      if (ctx.backendId === 'dsh' && relative === 'package.json') {
        let parsed: unknown;
        try { parsed = JSON.parse(data.content); }
        catch { diagnostics.push(`Invalid DSH profile package manifest JSON: ${descriptor.path}`); continue; }
        if (!record(parsed)) { diagnostics.push(`DSH profile package manifest is not a JSON object: ${descriptor.path}`); continue; }
        const dsh = record(parsed.dsh) ? parsed.dsh : undefined;
        const profileSection = dsh && record(dsh.profile) ? dsh.profile : undefined;
        const bundles = Array.isArray(profileSection?.bundles) ? profileSection.bundles.filter((value): value is string => typeof value === 'string') : [];
        const dependencies = record(parsed.dependencies) ? parsed.dependencies : {};
        const names = new Set([...bundles, ...Object.keys(dependencies)]);
        const managedBundles = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-auto-review', '@riffet/dsh-native-bridge']);
        for (const nativeId of names) {
          const isManaged = managedBundles.has(nativeId);
          const pluginScope: ExtensionScope = isManaged ? 'managed' : 'user';
          const pluginId = itemId(pluginScope, 'plugin', descriptor.absolutePath, nativeId);
          addItem({
            id: pluginId, kind: 'plugin', name: normalizeItemName(nativeId), scope: pluginScope,
            sourcePath: descriptor.path, nativeId, enabled: bundles.includes(nativeId), runtimeState: 'unknown',
            ...(isManaged ? { readOnlyReason: 'This bundle is managed by DSH or Riffet.' } : {}), documentId: descriptor.id,
          }, [descriptor]);
        }
      }
    }
  };

  const scanPlugins = async (source: SourceRoot): Promise<void> => {
    const dirs = pluginDirectories(ctx, source.scope, source.role);
    const rootReal = await resolveRealRoot(source.root).catch(() => undefined);
    for (const directory of dirs) {
      const manifests = await scanFiles(source, directory, (base, relative) => pluginManifest(base, relative), diagnostics, 8, rootReal);
      try {
        const base = path.resolve(source.root, directory);
        const entries = await readdir(base, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidateRoot = path.join(base, entry.name);
          if (!manifests.some(file => isWithin(candidateRoot, file.absolute))) diagnostics.push(`Plugin directory has no plugin manifest: ${displayPath(source.root, candidateRoot, source.scope)}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') diagnostics.push(`Cannot inspect plugin directory ${directory}: ${errMessage(error)}`);
      }
      for (const file of manifests) {
        let data: { content: string; symlink: boolean };
        try { const read = await readCandidate(file.absolute, source.root, rootReal, !file.symlink); data = { content: read.content, symlink: read.symlink }; }
        catch (error) { diagnostics.push(`Cannot read plugin manifest ${displayPath(source.root, file.absolute, source.scope)}: ${errMessage(error)}`); continue; }
        let parsed: unknown;
        try { parsed = JSON.parse(data.content); }
        catch { diagnostics.push(`Invalid plugin manifest JSON: ${displayPath(source.root, file.absolute, source.scope)}`); parsed = undefined; }
        const rel = path.relative(source.root, file.absolute);
        const manifestDirectory = path.basename(path.dirname(file.absolute));
        const pluginRelativeRoot = MANIFEST_DIRECTORY.test(manifestDirectory)
          ? path.dirname(path.dirname(file.absolute))
          : path.dirname(file.absolute);
        const pluginRoot = path.resolve(pluginRelativeRoot);
        const descriptor = addDoc(source, file.absolute, rel, 'plugin', file.symlink);
        const pluginName = (record(parsed) ? text(parsed.name) : undefined) ?? path.basename(pluginRoot);
        const id = itemId(descriptor.scope, 'plugin', pluginRoot);
        const item: ExtensionItem = {
          id, kind: 'plugin', name: normalizeItemName(pluginName),
          ...(record(parsed) && text(parsed.description) ? { description: redactSensitiveText(text(parsed.description)!).slice(0, 1000) } : {}),
          scope: descriptor.scope, sourcePath: displayPath(source.root, pluginRoot, source.scope), runtimeState: 'unknown',
          ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}), documentId: descriptor.id,
        };
        descriptor.itemId = id;
        if (!items.has(item.id)) {
          addItem(item, [descriptor]);
          pluginRoots.push({ source, root: pluginRoot, itemId: id });
        }
        if (!record(parsed)) diagnostics.push(`Plugin manifest does not contain a JSON object: ${displayPath(source.root, file.absolute, source.scope)}`);
        else if (!text(parsed.name)) diagnostics.push(`Plugin manifest is missing a name: ${displayPath(source.root, file.absolute, source.scope)}`);
      }
    }
  };

  const scanPiExtensions = async (source: SourceRoot): Promise<void> => {
    if (ctx.backendId !== 'pi' || source.role !== 'agent') return;
    const directory = source.scope === 'project' ? '.pi/extensions' : 'extensions';
    const base = path.resolve(source.root, directory);
    if (!isWithin(source.root, base)) return;
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') diagnostics.push(`Cannot read pi extension directory ${displayPath(source.root, base, source.scope)}: ${errMessage(error)}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const rootReal = await resolveRealRoot(source.root).catch(() => undefined);
    const addExtension = async (absolute: string, name: string, description?: string): Promise<void> => {
      if (rootReal) {
        try {
          const target = await realpath(absolute);
          if (!isWithin(rootReal, target)) { diagnostics.push(`Pi extension entry resolves outside its configuration root: ${displayPath(source.root, absolute, source.scope)}`); return; }
        } catch (error) {
          diagnostics.push(`Cannot inspect pi extension entry ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
          return;
        }
      }
      const relative = path.relative(source.root, absolute);
      const symlink = (await lstat(absolute)).isSymbolicLink() || await hasSymlinkAncestor(source.root, absolute);
      const descriptor = addDoc(source, absolute, relative, 'plugin', symlink);
      const id = itemId(descriptor.scope, 'plugin', descriptor.absolutePath);
      const item: ExtensionItem = {
        id, kind: 'plugin', name: normalizeItemName(name),
        ...(description ? { description: redactSensitiveText(description).slice(0, 1000) } : {}),
        scope: descriptor.scope, sourcePath: descriptor.path, runtimeState: 'unknown',
        ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}), documentId: descriptor.id,
      };
      descriptor.itemId ??= id;
      addItem(item, [descriptor]);
    };
    for (const entry of entries) {
      const absolute = path.resolve(base, entry.name);
      if (!isWithin(source.root, absolute)) continue;
      if (entry.isSymbolicLink() && rootReal) {
        try {
          if (!isWithin(rootReal, await realpath(absolute))) { diagnostics.push(`Pi extension symlink resolves outside its configuration root: ${displayPath(source.root, absolute, source.scope)}`); continue; }
        } catch (error) {
          diagnostics.push(`Cannot inspect pi extension symlink ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
          continue;
        }
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && /\.(?:ts|js)$/.test(entry.name)) {
        await addExtension(absolute, entry.name.replace(/\.(?:ts|js)$/, ''));
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      let packageName: string | undefined;
      let packageDescription: string | undefined;
      const declared: string[] = [];
      let manifestRaw: string | undefined;
      try { manifestRaw = (await readCandidate(path.join(absolute, 'package.json'), source.root, rootReal, false)).content; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') diagnostics.push(`Cannot read pi extension manifest ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
      }
      if (manifestRaw !== undefined) {
        let parsed: unknown;
        try { parsed = JSON.parse(manifestRaw); }
        catch { diagnostics.push(`Invalid pi extension manifest JSON: ${displayPath(source.root, absolute, source.scope)}`); }
        if (record(parsed)) {
          packageName = text(parsed.name);
          packageDescription = text(parsed.description);
          const pi = record(parsed.pi) ? parsed.pi : undefined;
          const declaredPaths = Array.isArray(pi?.extensions) ? pi.extensions.filter((value): value is string => typeof value === 'string') : [];
          for (const declaredPath of declaredPaths) {
            const resolved = path.resolve(absolute, declaredPath);
            if (!isWithin(source.root, resolved)) { diagnostics.push(`Pi extension path escapes its configuration root: ${displayPath(source.root, resolved, source.scope)}`); continue; }
            try {
              if ((await stat(resolved)).isFile()) declared.push(resolved);
              else diagnostics.push(`Pi extension entry is not a file: ${displayPath(source.root, resolved, source.scope)}`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') diagnostics.push(`Pi extension entry is missing: ${displayPath(source.root, resolved, source.scope)}`);
              else diagnostics.push(`Cannot inspect pi extension entry ${displayPath(source.root, resolved, source.scope)}: ${errMessage(error)}`);
            }
          }
        }
      }
      if (declared.length) {
        for (const file of [...new Set(declared)]) await addExtension(file, packageName ?? path.basename(file, path.extname(file)), packageDescription);
        continue;
      }
      let found = false;
      for (const index of ['index.ts', 'index.js']) {
        const candidate = path.join(absolute, index);
        try {
          if (!(await stat(candidate)).isFile()) continue;
          await addExtension(candidate, packageName ?? path.basename(absolute), packageDescription);
          found = true;
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') diagnostics.push(`Cannot inspect pi extension entry ${displayPath(source.root, candidate, source.scope)}: ${errMessage(error)}`);
        }
      }
      if (!found) diagnostics.push(`Pi extension directory has no entry point: ${displayPath(source.root, absolute, source.scope)}`);
    }
  };

  const seenMarkdown = new Set<string>();
  const scanMarkdownKind = async (source: SourceRoot, kind: 'skill' | 'rule' | 'command', directory: string, matcher: (name: string) => boolean): Promise<void> => {
    const rootReal = await resolveRealRoot(source.root).catch(() => undefined);
    for (const file of await scanFiles(source, directory, base => matcher(base), diagnostics, MAX_SCAN_DEPTH, rootReal)) {
      if (kind === 'skill' && file.absolute.endsWith('.riffet-disabled')) {
        try {
          await lstat(skillIdentityPath(file.absolute));
          diagnostics.push(`Skill 同时存在启用与停用入口，请先检查冲突：${displayPath(source.root, file.absolute, source.scope)}`);
          continue;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const canonical = await realpath(file.absolute).catch(() => file.absolute);
      const visitKey = `${source.scope}:${kind}:${canonical}`;
      if (seenMarkdown.has(visitKey)) continue;
      seenMarkdown.add(visitKey);
      let data: { content: string; symlink: boolean };
      try { data = await readCandidate(file.absolute, source.root, rootReal, !file.symlink); }
      catch (error) { diagnostics.push(`Cannot read ${kind} ${displayPath(source.root, file.absolute, source.scope)}: ${errMessage(error)}`); continue; }
      const pluginId = ownerFor(source, file.relative);
      const fallback = kind === 'skill' ? path.basename(path.dirname(file.absolute)) : kind === 'rule' ? path.basename(file.absolute) : path.basename(file.absolute, path.extname(file.absolute));
      const item = await addDocumentItem({ source, absolute: file.absolute, relative: file.relative, kind, name: fallback, ownerPluginId: pluginId, symlink: file.symlink || await dirHasSymlinkAncestor(source.root, path.dirname(file.absolute)), content: data.content });
      if (kind === 'skill' && item) {
        const descriptor = docs.get(item.documentId!)!;
        const disabled = file.absolute.endsWith('.riffet-disabled');
        if (disabled) item.enabled = false;
        else if (ctx.layout?.skillsAlwaysEnabled) item.enabled = true;
        else if (skillSettings && !item.ownerPluginId && item.scope !== 'builtin') item.enabled = skillSettings.enabled(fallback, data.content);
        if (descriptor.editable && !item.ownerPluginId) {
          item.actions = ['enable', 'disable', 'uninstall'];
          item.managementNote = ['codex', 'traex'].includes(ctx.backendId)
            ? '开关写入当前 Agent 配置，其他项目也可能受影响。删除会移走整个 Skill 目录，并保留备份。'
            : '开关按当前 Agent 的能力应用。文件停用或删除会影响共用此目录的 Agent；删除会保留整个目录的备份。';
        } else if (item.ownerPluginId) item.managementNote = '由插件提供；可通过所属插件统一启停和卸载。';
        const skillDirectory = path.dirname(file.absolute);
        const skillRelative = path.relative(source.root, skillDirectory).split(path.sep).join('/');
        const supportFiles = await scanFiles(source, skillRelative, (base, relative) => !isSkill(base)
          && /\.(?:md|mdc|txt|json|toml|ya?ml|py|sh|js|mjs|cjs|ts|tsx|jsx|html|css|xml|svg)$/i.test(base)
          && !/(?:^|\/)(?:\.git|node_modules)(?:\/|$)/i.test(relative), diagnostics, 5, rootReal);
        const detail = details.get(item.id);
        if (detail) {
          const files = new Map(detail.files.map(existing => [existing.id, existing]));
          const skillDirSymlink = file.symlink || await dirHasSymlinkAncestor(source.root, skillDirectory);
          for (const support of supportFiles) {
            if (support.symlink) {
              try {
                const target = await realpath(support.absolute);
                const resolvedRoot = rootReal ?? await resolveRealRoot(source.root);
                assertWithin(resolvedRoot, target, 'EXTENSION_PATH_OUTSIDE_ROOT');
                if (!(await stat(target)).isFile()) continue;
              } catch (error) { diagnostics.push(`Cannot read skill support file ${displayPath(source.root, support.absolute, source.scope)}: ${errMessage(error)}`); continue; }
            }
            const sharedLink = skillDirSymlink || support.symlink || await dirHasSymlinkAncestor(source.root, path.dirname(support.absolute));
            const descriptor = addDoc(source, support.absolute, support.relative, 'skill', sharedLink);
            descriptor.itemId = item.id;
            files.set(descriptor.id, { id: descriptor.id, path: descriptor.path, editable: descriptor.editable, ...(descriptor.reason ? { reason: descriptor.reason } : {}) });
          }
          details.set(item.id, { ...detail, files: [...files.values()] });
        }
      }
    }
  };

  const addKnownRuleFiles = async (source: SourceRoot): Promise<void> => {
    if (source.role === 'agent') {
      const fixedByBackend: Partial<Record<ExtensionContext['backendId'], { user: string[]; project: string[] }>> = {
        codex: { user: ['AGENTS.override.md', 'AGENTS.md'], project: ['AGENTS.override.md', 'AGENTS.md'] },
        claude: { user: ['CLAUDE.md'], project: ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'] },
        dsh: { user: [], project: [] },
        droid: { user: ['AGENTS.md'], project: ['AGENTS.md', 'CLAUDE.md'] },
        traex: { user: ['AGENTS.md'], project: ['AGENTS.md'] },
        pi: {
          user: ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'],
          project: ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.pi/SYSTEM.md', '.pi/APPEND_SYSTEM.md'],
        },
      };
      const fixed = ctx.layout?.ruleFiles[source.scope] ?? fixedByBackend[ctx.backendId]?.[source.scope] ?? [];
      const present = new Set<string>();
      const found: Array<{ relative: string; absolute: string; content: string; symlink: boolean }> = [];
      for (const relative of fixed) {
        const absolute = path.resolve(source.root, relative);
        try { await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; diagnostics.push(`Cannot inspect rule ${relative}: ${errMessage(error)}`); continue; }
        let data: { content: string; symlink: boolean };
        try { data = await readCandidate(absolute, source.root); } catch (error) { diagnostics.push(`Cannot read rule ${relative}: ${errMessage(error)}`); continue; }
        const symlink = data.symlink || await hasSymlinkAncestor(source.root, absolute);
        present.add(relative.split(path.sep).join('/'));
        found.push({ relative, absolute, content: data.content, symlink });
      }
      for (const file of found) {
        const normalized = file.relative.split(path.sep).join('/');
        const overridden = normalized === 'AGENTS.md' && present.has('AGENTS.override.md');
        const effectNote = overridden ? '已被 AGENTS.override.md 覆盖'
          : normalized === 'AGENTS.override.md' ? '优先覆盖 AGENTS.md'
            : normalized === 'CLAUDE.local.md' ? '本地私有 · 常驻生效'
              : '常驻生效';
        await addDocumentItem({
          source, absolute: file.absolute, relative: file.relative, kind: 'rule',
          name: path.basename(file.relative), effectNote, ownerPluginId: ownerFor(source, file.relative),
          ...(overridden ? { enabled: false } : {}), content: file.content, symlink: file.symlink,
        });
      }
    }
    for (const directory of markdownDirectories(ctx, source, 'rule')) {
      await scanMarkdownKind(source, 'rule', directory, isMarkdown);
    }
  };

  const scanJsonResources = async (): Promise<void> => {
    for (const file of configFiles) {
      if (file.descriptor.language !== 'json') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(file.content); }
      catch { diagnostics.push(`Invalid JSON extension config: ${file.descriptor.path}`); continue; }
      if (!record(parsed)) continue;
      const mcpValue = parsed.mcpServers ?? parsed.mcp_servers ?? (file.kind === 'mcp' ? parsed.servers : undefined);
      if (record(mcpValue)) {
        for (const [nativeId, config] of Object.entries(mcpValue)) {
          if (!record(config)) { diagnostics.push(`MCP server “${nativeId}” is not a JSON object in ${file.descriptor.path}`); continue; }
          const enabled = typeof config.enabled === 'boolean' ? config.enabled : typeof config.disabled === 'boolean' ? !config.disabled : undefined;
          const id = itemId(file.descriptor.scope, 'mcp', file.descriptor.absolutePath, nativeId);
          const item: ExtensionItem = {
            id, kind: 'mcp', name: normalizeItemName(text(config.name) ?? nativeId),
            ...(text(config.description) ? { description: redactSensitiveText(text(config.description)!).slice(0, 1000) } : {}),
            scope: file.descriptor.scope, sourcePath: file.descriptor.path,
            ...(ownerFor(file.source, file.relative) ? { ownerPluginId: ownerFor(file.source, file.relative) } : {}),
            nativeId, ...(enabled === undefined ? {} : { enabled }), runtimeState: 'unknown',
            ...(file.descriptor.reason ? { readOnlyReason: file.descriptor.reason } : {}), documentId: file.descriptor.id,
          };
          addItem(item, [file.descriptor]);
        }
      }
      const hookMap = record(parsed.hooks) ? parsed.hooks : ctx.backendId === 'droid' && file.kind === 'hook' ? parsed : undefined;
      if (record(hookMap)) {
        for (const [event, value] of Object.entries(hookMap)) {
          const hooks = Array.isArray(value) ? value : record(value) && Array.isArray(value.hooks) ? value.hooks : undefined;
          if (!hooks) { diagnostics.push(`Hook event “${event}” is not an array in ${file.descriptor.path}`); continue; }
          hooks.forEach((hook, index) => {
            const hookRecord = record(hook) ? hook : {};
            const nativeId = `${event}:${index}`;
            const id = itemId(file.descriptor.scope, 'hook', file.descriptor.absolutePath, nativeId);
            const item: ExtensionItem = {
              id, kind: 'hook', name: `${event} · ${index + 1}`,
              ...(text(hookRecord.name) ? { description: redactSensitiveText(text(hookRecord.name)!).slice(0, 1000) } : {}),
              scope: file.descriptor.scope, sourcePath: file.descriptor.path,
              ...(ownerFor(file.source, file.relative) ? { ownerPluginId: ownerFor(file.source, file.relative) } : {}),
              nativeId, ...(typeof hookRecord.enabled === 'boolean' ? { enabled: hookRecord.enabled } : {}),
              runtimeState: 'unknown', ...(file.descriptor.reason ? { readOnlyReason: file.descriptor.reason } : {}), documentId: file.descriptor.id,
            };
            addItem(item, [file.descriptor]);
          });
        }
      }
      const enabledPlugins = parsed.enabledPlugins ?? parsed.plugins;
      if (record(enabledPlugins)) {
        for (const [nativeId, state] of Object.entries(enabledPlugins)) {
          const enabled = typeof state === 'boolean' ? state : record(state) && typeof state.enabled === 'boolean' ? state.enabled : undefined;
          const id = itemId(file.descriptor.scope, 'plugin', file.descriptor.absolutePath, nativeId);
          addItem({ id, kind: 'plugin', name: normalizeItemName(nativeId), scope: file.descriptor.scope, sourcePath: file.descriptor.path, nativeId, ...(enabled === undefined ? {} : { enabled }), runtimeState: 'unknown', ...(file.descriptor.reason ? { readOnlyReason: file.descriptor.reason } : {}), documentId: file.descriptor.id }, [file.descriptor]);
        }
      }
    }
  };

  const scanPluginConfigFiles = async (source: SourceRoot): Promise<void> => {
    const rootReal = await resolveRealRoot(source.root).catch(() => undefined);
    for (const plugin of pluginRoots.filter(item => item.source === source)) {
      const relativeRoot = path.relative(source.root, plugin.root).split(path.sep).join('/');
      for (const file of await scanFiles(source, relativeRoot, base => ['hooks.json', 'mcp.json', '.mcp.json'].includes(base), diagnostics, 2, rootReal)) {
        let data: { content: string; symlink: boolean };
        try { const read = await readCandidate(file.absolute, source.root, rootReal, !file.symlink); data = { content: read.content, symlink: read.symlink }; }
        catch (error) { diagnostics.push(`Cannot read plugin extension config ${displayPath(source.root, file.absolute, source.scope)}: ${errMessage(error)}`); continue; }
        const kind: ExtensionKind = path.basename(file.absolute) === 'hooks.json' ? 'hook' : 'mcp';
        const descriptor = addDoc(source, file.absolute, file.relative, kind, data.symlink);
        configFiles.push({ source, absolute: file.absolute, relative: file.relative, descriptor, kind, content: data.content });
        const id = itemId(descriptor.scope, 'config', descriptor.absolutePath, kind);
        const configItem: ExtensionItem = {
          id, kind: 'config', name: path.basename(file.absolute), scope: descriptor.scope,
          sourcePath: descriptor.path, ownerPluginId: plugin.itemId, runtimeState: 'unknown',
          ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}), documentId: descriptor.id,
        };
        descriptor.itemId = id;
        addItem(configItem, [descriptor]);
      }
    }
  };

  for (const source of sources) {
    await scanConfig(source);
    await scanPlugins(source);
    await scanPiExtensions(source);
  }
  if (ctx.backendId === 'codex' || ctx.backendId === 'traex') {
    for (const file of configFiles.filter(item => ['config.toml', 'traecli.toml'].includes(path.basename(item.absolute)))) {
      for (const kind of ['mcp', 'hook'] as const) {
        const nativeId = `${kind}:config.toml`;
        const id = itemId(file.descriptor.scope, kind, file.descriptor.absolutePath, nativeId);
        addItem({ id, kind, name: `${kind === 'mcp' ? 'MCP' : 'Hooks'} · ${path.basename(file.absolute)}`, description: '此视图提供 TOML 配置文件；具体条目请查看原生运行状态。', scope: file.descriptor.scope, sourcePath: file.descriptor.path, runtimeState: 'unknown', ...(file.descriptor.reason ? { readOnlyReason: file.descriptor.reason } : {}), documentId: file.descriptor.id }, [file.descriptor]);
        diagnostics.push(`${file.descriptor.path} 以 TOML 原文编辑，不解析具体条目；MCP 和 Hook 条目可在有在线会话时查询原生目录。`);
      }
    }
  }
  // Scan component files only after plugin manifests are known so each component can link to its owner.
  for (const source of sources) {
    for (const directory of markdownDirectories(ctx, source, 'skill')) await scanMarkdownKind(source, 'skill', directory, isSkill);
    await addKnownRuleFiles(source);
    for (const directory of markdownDirectories(ctx, source, 'command')) await scanMarkdownKind(source, 'command', directory, name => /\.md$/i.test(name));
    for (const plugin of pluginRoots.filter(item => item.source === source)) {
      const relative = path.relative(source.root, plugin.root);
      for (const directory of ['skills', 'commands', 'rules']) {
        await scanMarkdownKind(source, directory === 'skills' ? 'skill' : directory === 'commands' ? 'command' : 'rule', path.posix.join(relative.split(path.sep).join('/'), directory), directory === 'skills' ? isSkill : directory === 'commands' ? name => /\.md$/i.test(name) : isMarkdown);
      }
    }
  }
  for (const source of sources) await scanPluginConfigFiles(source);
  await scanJsonResources();

  for (const item of items.values()) {
    if (!item.ownerPluginId || !item.documentId) continue;
    const owner = details.get(item.ownerPluginId);
    const component = docs.get(item.documentId);
    if (!owner || !component) continue;
    const files = new Map(owner.files.map(file => [file.id, file]));
    files.set(component.id, { id: component.id, path: component.path, editable: component.editable, ...(component.reason ? { reason: component.reason } : {}) });
    details.set(owner.item.id, { ...owner, files: [...files.values()] });
  }

  for (const source of sources) {
    for (const target of createTargetList(ctx, source)) {
      if (target.fileName) {
        const absolute = path.resolve(source.root, target.directory, target.fileName);
        try { await lstat(absolute); continue; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
            diagnostics.push(`Cannot inspect create target ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
            continue;
          }
        }
      }
      createTargets.set(target.id, { contract: target, root: source.root });
    }
  }

  if (skillSettings) diagnostics.push(...skillSettings.diagnostics);
  for (const { item, document } of riffetSkillEntries(ctx)) {
    docs.set(document.id, document);
    addItem(item, [document]);
  }
  // An isolated launch reads the project's own files whatever scope they were filed under (a linked skill is
  // `managed`), and nothing of the owner's: what it does not read is not listed, opened or written from here.
  const projectRoots = new Set(sources.filter(source => source.scope === 'project').map(source => source.root));
  const read = (scope: ExtensionScope, root?: string) => scopeInEffect(ctx, scope) || (root !== undefined && projectRoots.has(root));
  for (const [id, item] of items) if (!read(item.scope, item.documentId ? docs.get(item.documentId)?.root : undefined)) { items.delete(id); details.delete(id); }
  for (const [id, document] of docs) if (!read(document.scope, document.root)) docs.delete(id);
  for (const [id, target] of createTargets) if (!scopeInEffect(ctx, target.contract.scope)) createTargets.delete(id);
  const inventory = {
    backendId: ctx.backendId,
    profileId: ctx.profile.id,
    items: [...items.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id)),
    diagnostics: [...new Set(diagnostics)].slice(0, 400),
    createTargets: [...createTargets.values()].map(value => value.contract),
    checkedAt: new Date().toISOString(),
  };
  return { inventory, items, details, documents: docs, createTargets };
}
