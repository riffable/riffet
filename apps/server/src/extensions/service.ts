import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ExtensionActionRequest, ExtensionActionResult, ExtensionCreateTarget, ExtensionDetail, ExtensionDocument, ExtensionInventory, ExtensionItem, ExtensionRuntimeReport } from '../../../../packages/contracts/src/extensions.js';
import { AppError } from '../errors.js';
import { createExtensionFile, readExtensionFile, writeExtensionFile } from './files.js';
import { createTargetDocumentDescriptor, discoverExtensions, userRootFor } from './discovery.js';
import { removeSkillFiles, setSkillFileEnabled } from './skill-files.js';
import { setSkillSetting } from './skill-settings.js';
import type { ExtensionContext, ExtensionDocumentDescriptor } from './types.js';

function validRelativePath(input: string): string {
  if (typeof input !== 'string' || input.length > 1024 || input.includes('\0')) throw new AppError('INVALID_EXTENSION_PATH', 'Extension path is invalid');
  const normalized = input.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new AppError('INVALID_EXTENSION_PATH', 'Extension path must be a normalized root-relative path');
  }
  return segments.join('/');
}

function slugSegments(input: string): boolean {
  return input.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(segment));
}

function validateTargetPath(target: ExtensionCreateTarget, input: string): string {
  const relative = validRelativePath(input);
  const directory = target.directory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const targetPrefix = directory ? `${directory}/` : '';
  if (directory && relative !== directory && !relative.startsWith(targetPrefix)) throw new AppError('INVALID_EXTENSION_PATH', 'Extension path must stay inside the selected create target');
  const remaining = directory ? relative.slice(targetPrefix.length) : relative;
  if (target.fileName) {
    if (relative !== path.posix.join(directory, target.fileName).replace(/^\.\//, '')) throw new AppError('INVALID_EXTENSION_PATH', 'The selected target uses a fixed file name');
    return relative;
  }
  if (!remaining || !slugSegments(remaining.split('/').slice(0, -1).join('/') || (target.kind === 'skill' ? 'invalid' : 'root'))) throw new AppError('INVALID_EXTENSION_PATH', 'Extension path contains an invalid name');
  const parts = remaining.split('/');
  const leaf = parts.at(-1)!;
  if (parts.length > 6) throw new AppError('INVALID_EXTENSION_PATH', 'Extension path is nested too deeply');
  switch (target.kind) {
    case 'skill':
      if (parts.length < 2 || leaf !== 'SKILL.md') throw new AppError('INVALID_EXTENSION_PATH', 'A skill must end in <name>/SKILL.md');
      if (!slugSegments(parts.slice(0, -1).join('/'))) throw new AppError('INVALID_EXTENSION_PATH', 'Skill name contains invalid characters');
      break;
    case 'rule':
      if (!/\.(?:md|mdc|rules)$/i.test(leaf)) throw new AppError('INVALID_EXTENSION_PATH', 'Rules must use a .md, .mdc, or .rules file');
      if (!slugSegments(parts.map((part, index) => index === parts.length - 1 ? part.replace(/\.(?:md|mdc|rules)$/i, '') : part).join('/'))) throw new AppError('INVALID_EXTENSION_PATH', 'Rule path contains invalid characters');
      break;
    case 'command':
      if (!/\.md$/i.test(leaf)) throw new AppError('INVALID_EXTENSION_PATH', 'Commands must use a .md file');
      if (!slugSegments(parts.map((part, index) => index === parts.length - 1 ? part.replace(/\.md$/i, '') : part).join('/'))) throw new AppError('INVALID_EXTENSION_PATH', 'Command path contains invalid characters');
      break;
    default: throw new AppError('INVALID_EXTENSION_PATH', 'This target does not accept arbitrary file names');
  }
  return relative;
}

/** The skills directories a backend's declared layout reads; file operations on a skill are allowed under these as well as under the conventional ones. */
function skillTrees(ctx: ExtensionContext): string[] {
  const layout = ctx.layout;
  return layout ? [...layout.directories.user.skill, ...layout.directories.project.skill, ...layout.sharedRoot?.directories.skill ?? []] : [];
}

function lookupDocument(descriptor: ExtensionDocumentDescriptor | undefined): ExtensionDocumentDescriptor {
  if (!descriptor || !/^[a-f0-9]{40}$/.test(descriptor.id)) throw new AppError('EXTENSION_DOCUMENT_NOT_FOUND', 'Extension document does not exist for this backend profile', 404);
  return descriptor;
}

export class ExtensionService {
  private readonly snapshots = new Map<string, { at: number; snapshot: Awaited<ReturnType<typeof discoverExtensions>> }>();
  private readonly inflight = new Map<string, Promise<Awaited<ReturnType<typeof discoverExtensions>>>>();

  constructor(private readonly stateDir: string) {}

  private assertContext(ctx: ExtensionContext): void {
    if (!ctx || !ctx.profile || ctx.backendId !== ctx.profile.backendId) throw new AppError('EXTENSION_BACKEND_MISMATCH', 'Extension backend and profile do not match', 400);
  }

  private contextKey(ctx: ExtensionContext): string {
    return JSON.stringify([ctx.backendId, ctx.profile.id, ctx.profile.config, ctx.project?.id ?? '', ctx.project?.cwd ?? '']);
  }

  private async snapshot(ctx: ExtensionContext, fresh = false): Promise<Awaited<ReturnType<typeof discoverExtensions>>> {
    const key = this.contextKey(ctx);
    if (!fresh) {
      const cached = this.snapshots.get(key);
      if (cached && Date.now() - cached.at < 30_000) return cached.snapshot;
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }
    const promise = discoverExtensions(ctx).then(snapshot => {
      // An invalidation or newer scan must not be undone by an older in-flight read.
      if (this.inflight.get(key) !== promise) return snapshot;
      if (this.snapshots.size >= 32) this.snapshots.clear();
      this.snapshots.set(key, { at: Date.now(), snapshot });
      return snapshot;
    }).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(ctx?: ExtensionContext): void {
    if (ctx) {
      const key = this.contextKey(ctx);
      this.snapshots.delete(key);
      this.inflight.delete(key);
    } else {
      this.snapshots.clear();
      this.inflight.clear();
    }
  }

  async list(ctx: ExtensionContext): Promise<ExtensionInventory> {
    this.assertContext(ctx);
    return (await this.snapshot(ctx, true)).inventory;
  }

  async applySkillStates(ctx: ExtensionContext, items: ExtensionItem[], states: Array<{ path: string; enabled: boolean }>): Promise<ExtensionItem[]> {
    this.assertContext(ctx);
    const snapshot = await this.snapshot(ctx);
    const statePaths = new Map<string, boolean>();
    // Native discovery can report aliases of canonical roots (e.g. /var on macOS).
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(states.length, 8) }, async () => {
      while (next < states.length) {
        const value = states[next++];
        if (!path.isAbsolute(value.path)) continue;
        statePaths.set(path.resolve(value.path), value.enabled);
        const canonical = await realpath(value.path).catch(() => path.resolve(value.path));
        statePaths.set(canonical, value.enabled);
      }
    }));
    // Enrich this response, never the mutable cache: concurrent list/detail requests
    // can hold different snapshots while sharing the same native state read.
    return items.map(item => {
      if (item.kind !== 'skill' || !item.documentId || item.scope === 'builtin') return item;
      const descriptor = snapshot.documents.get(item.documentId);
      if (!descriptor || descriptor.path !== item.sourcePath || descriptor.absolutePath.endsWith('.riffet-disabled')) return item;
      const enabled = statePaths.get(descriptor.absolutePath);
      if (enabled === undefined) return item;
      return { ...item, enabled, actions: ['enable', 'disable', ...(item.actions?.includes('uninstall') ? ['uninstall' as const] : [])],
        managementNote: '开关写入当前 Agent 的用户配置，不改动 Skill 文件；同一配置的其他项目也会受影响。'
          + (item.actions?.includes('uninstall') ? '删除会移走整个 Skill 目录并保留备份。' : '来源文件由 Agent 或插件维护，不能单独删除。'),
      };
    });
  }

  async manageSkillFiles(ctx: ExtensionContext, request: ExtensionActionRequest, nativeSettings: boolean): Promise<ExtensionActionResult> {
    this.assertContext(ctx);
    const snapshot = await this.snapshot(ctx, true);
    const item = request.itemId ? snapshot.items.get(request.itemId) : undefined;
    if (!item || item.kind !== 'skill' || !item.documentId) throw new AppError('EXTENSION_NOT_FOUND', 'The skill is not in the current configuration', 404, undefined, { subject: 'skill' });
    if (!item.actions?.includes(request.action)) throw new AppError('EXTENSION_READ_ONLY', item.readOnlyReason ?? 'Manage this skill through its plugin', 403, undefined, item.readOnlyReason ? { subject: 'reason', reason: item.readOnlyReason } : { subject: 'plugin' });
    if (request.scope && item.scope !== request.scope) throw new AppError('EXTENSION_SCOPE_MISMATCH', 'The scope does not match where the skill comes from', 409, undefined, { subject: 'skill' });
    const descriptor = lookupDocument(snapshot.documents.get(item.documentId));
    if (!request.expectedHash || !/^[a-f0-9]{64}$/.test(request.expectedHash)) throw new AppError('INVALID_EXTENSION_HASH', 'Read the skill\'s current content before managing it', 409);
    if (request.action === 'uninstall') {
      const removed = await removeSkillFiles(descriptor, request.expectedHash, this.stateDir, skillTrees(ctx));
      return { success: true, applyEffect: '已移除整个 Skill 目录，共用该目录的 Agent 将不再发现它。已加载内容仍可能保留在现有会话中。', output: `备份目录：${removed.backupPath}` };
    }
    if (!['enable', 'disable'].includes(request.action)) throw new AppError('EXTENSION_ACTION_UNSUPPORTED', 'This skill does not support this action', 409, undefined, { subject: 'skill' });
    const enabled = request.action === 'enable';
    const disabledFile = descriptor.absolutePath.endsWith('.riffet-disabled');
    if (nativeSettings) {
      const document = await readExtensionFile(descriptor);
      if (document.hash !== request.expectedHash) throw new AppError('CONFIG_CONFLICT', 'The skill changed since it was read; reload it and try again', 409, undefined, { subject: 'skill' });
      const result = await setSkillSetting(ctx, userRootFor(ctx), { name: path.basename(path.dirname(descriptor.absolutePath)), scope: item.scope as 'user' | 'project', content: document.content }, enabled, this.stateDir);
      if (!disabledFile || !enabled || !result.success) return result;
    }
    await setSkillFileEnabled(descriptor, enabled, request.expectedHash, this.stateDir, skillTrees(ctx));
    return { success: true, applyEffect: enabled
      ? '已恢复 Skill 入口文件；共用此目录的 Agent 可重新发现它，Agent 配置中的其他限制仍然生效。请刷新或新建会话。'
      : '已停用 Skill 入口文件，支持文件保持原样；共用此目录的 Agent 将不再发现它。已加载内容可能保留在现有会话中。' };
  }

  /** Only discovered absolute paths may be translated into this profile's public path vocabulary. */
  async normalizeRuntimeReport(ctx: ExtensionContext, report: ExtensionRuntimeReport): Promise<ExtensionRuntimeReport> {
    this.assertContext(ctx);
    if (!report.entries.some(entry => entry.sourcePath && path.isAbsolute(entry.sourcePath))) return report;
    const snapshot = await this.snapshot(ctx);
    const paths = new Map<string, Set<string>>();
    for (const document of snapshot.documents.values()) {
      const absolute = path.resolve(document.absolutePath);
      const candidates = paths.get(absolute) ?? new Set<string>();
      candidates.add(document.path);
      paths.set(absolute, candidates);
    }
    const reportedPaths = [...new Set(report.entries.flatMap(entry => entry.sourcePath && path.isAbsolute(entry.sourcePath) ? [entry.sourcePath] : []))];
    const canonicalPaths = new Map<string, string>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, reportedPaths.length) }, async () => {
      while (next < reportedPaths.length) {
        const source = reportedPaths[next++];
        // Canonical roots in discovery may differ from CLI paths (e.g. /var vs /private/var).
        canonicalPaths.set(source, await realpath(source).catch(() => path.resolve(source)));
      }
    }));
    return { ...report, entries: report.entries.map(entry => {
      if (!entry.sourcePath || !path.isAbsolute(entry.sourcePath)) return entry;
      const candidates = paths.get(canonicalPaths.get(entry.sourcePath)!) ?? paths.get(path.resolve(entry.sourcePath));
      // A name/suffix match cannot establish file identity, nor can ambiguous overlapping roots.
      return candidates?.size === 1 ? { ...entry, sourcePath: [...candidates][0] } : entry;
    }) };
  }

  async detail(ctx: ExtensionContext, itemId: string): Promise<ExtensionDetail> {
    this.assertContext(ctx);
    if (typeof itemId !== 'string' || !/^[a-f0-9]{40}$/.test(itemId)) throw new AppError('EXTENSION_NOT_FOUND', 'Extension does not exist', 404);
    let detail = (await this.snapshot(ctx)).details.get(itemId);
    if (!detail) detail = (await this.snapshot(ctx, true)).details.get(itemId);
    if (!detail) throw new AppError('EXTENSION_NOT_FOUND', 'Extension does not exist for this backend profile', 404);
    return detail;
  }

  async readDocument(ctx: ExtensionContext, documentId: string): Promise<ExtensionDocument> {
    this.assertContext(ctx);
    if (typeof documentId !== 'string' || !/^[a-f0-9]{40}$/.test(documentId)) throw new AppError('EXTENSION_DOCUMENT_NOT_FOUND', 'Extension document does not exist', 404);
    let rawDescriptor = (await this.snapshot(ctx)).documents.get(documentId);
    if (!rawDescriptor) rawDescriptor = (await this.snapshot(ctx, true)).documents.get(documentId);
    const descriptor = lookupDocument(rawDescriptor);
    return readExtensionFile(descriptor);
  }

  async writeDocument(ctx: ExtensionContext, documentId: string, input: { content: string; expectedHash: string }): Promise<ExtensionDocument> {
    this.assertContext(ctx);
    if (typeof documentId !== 'string' || !/^[a-f0-9]{40}$/.test(documentId)) throw new AppError('EXTENSION_DOCUMENT_NOT_FOUND', 'Extension document does not exist', 404);
    let rawDescriptor = (await this.snapshot(ctx)).documents.get(documentId);
    if (!rawDescriptor) rawDescriptor = (await this.snapshot(ctx, true)).documents.get(documentId);
    const descriptor = lookupDocument(rawDescriptor);
    const updated = await writeExtensionFile(descriptor, input, this.stateDir);
    return updated;
  }

  async resolveDocumentPath(ctx: ExtensionContext, documentId: string, allowReadOnly = false): Promise<string> {
    this.assertContext(ctx);
    if (typeof documentId !== 'string' || !/^[a-f0-9]{40}$/.test(documentId)) throw new AppError('EXTENSION_DOCUMENT_NOT_FOUND', 'Extension document does not exist', 404);
    let rawDescriptor = (await this.snapshot(ctx)).documents.get(documentId);
    if (!rawDescriptor) rawDescriptor = (await this.snapshot(ctx, true)).documents.get(documentId);
    const descriptor = lookupDocument(rawDescriptor);
    if (!descriptor.editable && !allowReadOnly) throw new AppError('EXTENSION_READ_ONLY', descriptor.reason ?? 'This extension document is read-only', 403, undefined, descriptor.reason ? { subject: 'reason', reason: descriptor.reason } : undefined);
    await readExtensionFile(descriptor);
    return descriptor.absolutePath;
  }

  async createDocument(ctx: ExtensionContext, input: { targetId: string; path: string; content: string }): Promise<ExtensionDocument> {
    this.assertContext(ctx);
    if (!input || typeof input.targetId !== 'string') throw new AppError('INVALID_EXTENSION_TARGET', 'A create target is required', 400, undefined, { subject: 'create' });
    let snapshot = await this.snapshot(ctx);
    let selected = snapshot.createTargets.get(input.targetId);
    if (!selected) {
      snapshot = await this.snapshot(ctx, true);
      selected = snapshot.createTargets.get(input.targetId);
    }
    if (!selected) throw new AppError('EXTENSION_TARGET_NOT_FOUND', 'Extension create target is unavailable for this backend profile', 404);
    const relative = validateTargetPath(selected.contract, input.path);
    const scope = selected.contract.scope;
    const kind = selected.contract.kind;
    const projection = ctx.backendId === 'claude' && selected.contract.id === 'user:mcp' ? 'claudeMcpServers' : undefined;
    const descriptor = createTargetDocumentDescriptor(ctx, selected.root, scope, relative, kind, projection);
    const created = await createExtensionFile(descriptor, input.content, this.stateDir);
    // Re-discover the canonical item descriptor. Some providers share one JSON file for MCP and
    // hooks, so its document kind can be broader than the create target kind.
    const after = await this.snapshot(ctx, true);
    const matching = [...after.documents.values()].find(item => item.absolutePath === descriptor.absolutePath);
    if (!matching) return created;
    return readExtensionFile(matching);
  }
}
