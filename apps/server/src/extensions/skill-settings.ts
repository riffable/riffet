import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionActionResult } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { atomicWriteConfigDocument, hashConfigContent, readConfigDocumentBytes } from '../settings/config-documents.js';
import { assertWithin } from '../workspace/scope.js';
import type { ExtensionContext } from './types.js';

/** Configuration support only: callers must verify the installed native version before writing. */
export const SKILL_SETTINGS_MIN_VERSIONS = { claude: '2.1.129', droid: '0.173.0' } as const;

type SkillBackend = keyof typeof SKILL_SETTINGS_MIN_VERSIONS;
type Scope = 'user' | 'project';
type JsonObject = Record<string, unknown>;
interface SettingsFile {
  root: string;
  filePath: string;
  scope: Scope;
  local?: boolean;
  data: JsonObject;
  previous?: Buffer;
  error?: string;
}
interface SkillInput { name: string; scope: Scope; content: string; }
interface SkillMetadata { name?: string; enabled?: boolean; }
const claudeStates = new Set(['on', 'off', 'name-only', 'user-invocable-only']);

function object(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function supported(backend: string): backend is SkillBackend { return backend === 'claude' || backend === 'droid'; }
function validName(name: string, backend: SkillBackend): boolean {
  return name.length <= 160 && (backend === 'droid' ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) : /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(name));
}

/** Inline containers/quoted values must close on the same line, so later keys are unambiguous. */
function assertInlineValue(value: string): void {
  if (!value || value.startsWith('#') || /^[|>][+\-\d]*(?:\s+#.*)?$/.test(value)) return;
  if (/^[&*!]/.test(value)) throw new Error('SKILL.md 使用了 YAML 标签、锚点或别名，需通过原生工具管理');
  if (!/^["'[{]/.test(value)) return;
  const containers: string[] = [];
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quote) {
      if (quote === '"' && char === '\\') { index++; continue; }
      if (quote === "'" && char === "'" && value[index + 1] === "'") { index++; continue; }
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') containers.push(char);
    else if (char === ']' || char === '}') {
      if (containers.pop() !== (char === ']' ? '[' : '{')) throw new Error('SKILL.md 的 YAML 容器无法安全识别');
    }
    if (!quote && !containers.length) {
      if (!/^\s*(?:#.*)?$/.test(value.slice(index + 1))) throw new Error('SKILL.md 的 YAML 标量无法安全识别');
      return;
    }
  }
  throw new Error('SKILL.md 使用了跨行引号或容器，无法安全判定元数据');
}

/** Deliberately not a YAML parser. Complex relevant scalars, duplicate keys and merges are unknown. */
function metadata(content: string, backend: SkillBackend): SkillMetadata {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') {
    if (lines[0]?.startsWith('---')) throw new Error('SKILL.md 的 frontmatter 分隔符不明确，需通过原生工具管理');
    return {};
  }
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) throw new Error('SKILL.md 的 frontmatter 未闭合');
  const result: SkillMetadata = {};
  const seen = new Set<string>();
  let blockScalarIndent: number | undefined;
  let hasRootMapping = false;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const whitespace = line.match(/^\s*/)![0];
    if (whitespace.includes('\t')) throw new Error('SKILL.md 的 YAML 缩进无法安全识别');
    const indent = whitespace.length;
    if (indent && !hasRootMapping) throw new Error('SKILL.md 的顶层 YAML 缩进无法安全识别');
    if (blockScalarIndent !== undefined && indent > blockScalarIndent) continue;
    blockScalarIndent = undefined;
    const trimmed = line.slice(indent);
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    // Flow maps, explicit/quoted keys, merges, tags and root sequences can hide
    // another effective name. Never interpret unsupported syntax as a missing name.
    if (!indent && !match) throw new Error('SKILL.md 不是可安全识别的简单 YAML 映射，需通过原生工具管理');
    const raw = match?.[2] ?? trimmed.replace(/^-\s+/, '');
    assertInlineValue(raw);
    if (/^[|>][+\-\d]*(?:\s+#.*)?$/.test(raw)) blockScalarIndent = indent;
    if (indent || !match) continue;
    hasRootMapping = true;
    const key = match[1]!;
    if (seen.has(key)) throw new Error('SKILL.md 有重复元数据键，需通过原生工具管理');
    seen.add(key);
    if (key !== 'name' && (backend !== 'droid' || key !== 'enabled')) continue;
    if (key === 'enabled') {
      const boolean = raw.match(/^(true|false)(?:\s+#.*)?$/);
      if (!boolean) throw new Error('SKILL.md enabled 不是可识别的布尔值，需通过原生工具管理');
      result.enabled = boolean[1] === 'true';
    } else {
      const scalar = raw.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z0-9][A-Za-z0-9._:/-]*)(?:\s+#.*)?$/);
      if (!scalar) throw new Error('SKILL.md name 不是可识别的简单名称，需通过原生工具管理');
      const value = scalar[1];
      result.name = value.startsWith('"') ? JSON.parse(value) as string
        : value.startsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;
      if (!validName(result.name, backend)) throw new Error('SKILL.md name 不符合当前 Agent 的名称规则');
    }
  }
  return result;
}

function skillName(name: string, content: string, backend: SkillBackend): SkillMetadata & { name: string } {
  const parsed = metadata(content, backend);
  if (backend === 'droid' && !parsed.name) throw new Error('Droid Skill 缺少可识别的 name，无法安全匹配原生设置');
  const resolved = parsed.name ?? name;
  if (!validName(resolved, backend)) throw new Error('Skill 名称无法安全匹配原生设置');
  return { ...parsed, name: resolved };
}

async function rejectSymlinks(root: string, filePath: string): Promise<void> {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(filePath);
  assertWithin(absoluteRoot, absolute, 'EXTENSION_PATH_OUTSIDE_ROOT');
  let current = absoluteRoot;
  const segments = ['', ...path.relative(absoluteRoot, absolute).split(path.sep)];
  for (let index = 0; index < segments.length; index++) {
    if (segments[index]) current = path.join(current, segments[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new AppError('CONFIG_SYMLINK_UNSUPPORTED', 'The skill settings path contains a symbolic link and cannot be read or written safely', 409);
      if (index < segments.length - 1 && !info.isDirectory()) throw new AppError('CONFIG_NOT_DIRECTORY', 'A parent of the skill settings file is not a directory', 409);
      if (index === segments.length - 1 && !info.isFile()) throw new AppError('CONFIG_NOT_FILE', 'The skill settings file is not a regular file', 409);
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw reason;
    }
  }
}

function validateSettings(data: JsonObject, backend: SkillBackend): void {
  const value = data[backend === 'claude' ? 'skillOverrides' : 'disabledSkills'];
  if (value === undefined) return;
  if (backend === 'claude') {
    if (!object(value) || Object.values(value).some(state => typeof state !== 'string' || !claudeStates.has(state))) {
      throw new AppError('INVALID_SKILL_SETTINGS', 'skillOverrides must map names to supported states', 409);
    }
  } else if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) {
    throw new AppError('INVALID_SKILL_SETTINGS', 'disabledSkills must be an array of names', 409);
  }
}

async function loadSettings(ctx: ExtensionContext, userRoot: string): Promise<SettingsFile[]> {
  if (!supported(ctx.backendId)) return [];
  const files: SettingsFile[] = [{ root: path.resolve(userRoot), filePath: path.resolve(userRoot, 'settings.json'), scope: 'user', data: {} }];
  if (ctx.project) {
    const root = path.resolve(ctx.project.cwd);
    const directory = ctx.backendId === 'claude' ? '.claude' : '.factory';
    files.push({ root, filePath: path.join(root, directory, 'settings.json'), scope: 'project', data: {} });
    if (ctx.backendId === 'claude') files.push({ root, filePath: path.join(root, directory, 'settings.local.json'), scope: 'project', local: true, data: {} });
  }
  await Promise.all(files.map(async file => {
    try {
      await rejectSymlinks(file.root, file.filePath);
      try { file.previous = await readConfigDocumentBytes(file.filePath); }
      catch (reason) { if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return; throw reason; }
      let parsed: unknown;
      try { parsed = JSON.parse(file.previous.toString('utf8')); }
      catch { throw new AppError('INVALID_SKILL_SETTINGS', 'The settings file is not valid JSON', 409); }
      if (!object(parsed)) throw new AppError('INVALID_SKILL_SETTINGS', 'The settings file must be a JSON object', 409);
      validateSettings(parsed, ctx.backendId as SkillBackend);
      file.data = parsed;
    } catch (reason) {
      // Never return raw JSON or a JSON parser's excerpt: settings may contain credentials.
      file.error = `${file.filePath}：${reason instanceof AppError ? reason.message : '无法读取 Skill 设置。'}`;
    }
  }));
  return files;
}

function enabledIn(files: SettingsFile[], backend: SkillBackend, name: string, parsed: SkillMetadata): boolean | undefined {
  if (files.some(file => file.error)) return undefined;
  if (backend === 'droid') return parsed.enabled !== false && !files.some(file => (file.data.disabledSkills as string[] | undefined)?.includes(name));
  let state = 'on';
  for (const file of files) {
    const overrides = file.data.skillOverrides as JsonObject | undefined;
    if (overrides && Object.hasOwn(overrides, name)) state = overrides[name] as string;
  }
  return state !== 'off';
}

export async function readSkillSettings(ctx: ExtensionContext, userRoot: string): Promise<{
  enabled(name: string, content: string): boolean | undefined;
  diagnostics: string[];
}> {
  const files = await loadSettings(ctx, userRoot);
  const diagnostics = files.flatMap(file => file.error ? [file.error] : []);
  return {
    diagnostics,
    enabled(name, content) {
      if (!supported(ctx.backendId)) return undefined;
      try {
        const parsed = skillName(name, content, ctx.backendId);
        return enabledIn(files, ctx.backendId, parsed.name, parsed);
      }
      catch (reason) {
        const message = `${name}：${reason instanceof Error ? reason.message : '无法确认 Skill 启停状态。'}`;
        if (!diagnostics.includes(message)) diagnostics.push(message);
        return undefined;
      }
    },
  };
}

export async function setSkillSetting(ctx: ExtensionContext, userRoot: string, input: SkillInput, enabled: boolean, stateDir: string): Promise<ExtensionActionResult> {
  if (!supported(ctx.backendId)) throw new AppError('EXTENSION_ACTION_UNSUPPORTED', 'This agent has no native skill settings adapter', 409, undefined, { subject: 'skillSettings' });
  if (!['user', 'project'].includes(input.scope) || (input.scope === 'project' && !ctx.project)) throw new AppError('EXTENSION_SCOPE_UNSUPPORTED', 'A project-level skill action needs a valid project', 409, undefined, { subject: 'skill' });
  let parsed: SkillMetadata & { name: string };
  try { parsed = skillName(input.name, input.content, ctx.backendId); }
  catch (reason) { throw new AppError('SKILL_METADATA_UNSUPPORTED', reason instanceof Error ? reason.message : 'The skill metadata could not be read safely', 409); }
  const files = await loadSettings(ctx, userRoot);
  if (files.some(file => file.error)) throw new AppError('INVALID_SKILL_SETTINGS', 'Not every native setting could be read safely; no configuration was changed', 409, { diagnostics: files.flatMap(file => file.error ? [file.error] : []) });
  const selected = files.find(file => file.scope === input.scope && (input.scope === 'user' || ctx.backendId === 'droid' || file.local));
  if (!selected) throw new AppError('EXTENSION_SCOPE_UNSUPPORTED', 'No native settings were found for the chosen scope', 409, undefined, { subject: 'skillSettings' });
  const next: JsonObject = { ...selected.data };
  if (ctx.backendId === 'claude') {
    next.skillOverrides = { ...selected.data.skillOverrides as JsonObject | undefined, [parsed.name]: enabled ? 'on' : 'off' };
  } else {
    const names = selected.data.disabledSkills as string[] | undefined ?? [];
    next.disabledSkills = enabled ? names.filter(name => name !== parsed.name) : names.includes(parsed.name) ? names : [...names, parsed.name];
  }
  const projected = files.map(file => file === selected ? { ...file, data: next } : file);
  if (enabledIn(projected, ctx.backendId, parsed.name, parsed) !== enabled) {
    throw new AppError(ctx.backendId === 'droid' ? 'SKILL_STILL_DISABLED' : 'SKILL_SETTING_OVERRIDDEN', ctx.backendId === 'droid'
      ? 'disabledSkills in another scope, or enabled: false in SKILL.md, still disables this skill; no configuration was changed'
      : 'A higher-priority project setting overrides this choice; no configuration was changed', 409);
  }
  if (JSON.stringify(next) === JSON.stringify(selected.data)) {
    return { success: true, applyEffect: '所选作用域已是目标状态，未重复写入配置。' };
  }
  // Operate on the original unredacted object in memory; untouched credentials and unknown keys survive.
  await rejectSymlinks(selected.root, selected.filePath);
  await mkdir(selected.root, { recursive: true, mode: 0o700 });
  await atomicWriteConfigDocument({
    stateDir, root: selected.root, filePath: selected.filePath,
    content: JSON.stringify(next, null, 2) + '\n', previous: selected.previous,
    expectedHash: hashConfigContent(selected.previous ?? Buffer.alloc(0)),
  });
  const verified = await readSkillSettings(ctx, userRoot);
  const applied = verified.enabled(parsed.name, input.content) === enabled;
  return {
    success: applied,
    applyEffect: applied ? '已写入原生 Skill 设置。Agent 读取配置后生效；已经进入会话的技能内容不会从上下文移除。'
      : '配置已写入，但其他设置发生变化，未能确认目标状态；请刷新后检查。',
    ...(verified.diagnostics.length ? { diagnostics: verified.diagnostics } : {}),
  };
}
