import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as configDocuments from '../settings/config-documents.js';
import { readSkillSettings, setSkillSetting } from './skill-settings.js';
import type { ExtensionContext } from './types.js';

let root: string;
let user: string;
let project: string;
let state: string;
const content = '---\nname: review\ndescription: Review code.\n---\nReview changes.\n';
function context(backendId: 'claude' | 'droid', withProject = true): ExtensionContext {
  return {
    backendId, profile: { id: 'test', backendId, name: 'Test', config: {} },
    ...(withProject ? { project: { id: 'project', name: 'Project', cwd: project, createdAt: '', updatedAt: '' } } : {}),
  };
}
async function put(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
async function json(file: string) { return JSON.parse(await readFile(file, 'utf8')); }

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'riffet-skill-settings-'));
  user = path.join(root, 'user'); project = path.join(root, 'project'); state = path.join(root, 'state');
  await Promise.all([mkdir(user), mkdir(project)]);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('native skill setting persistence', () => {
  it('resolves Claude user, shared project, then local overrides and writes only the chosen scope', async () => {
    const ctx = context('claude');
    const userFile = path.join(user, 'settings.json');
    const shared = path.join(project, '.claude/settings.json');
    const local = path.join(project, '.claude/settings.local.json');
    await put(userFile, { skillOverrides: { review: 'off' }, userOnly: true });
    await put(shared, { skillOverrides: { review: 'on' } });
    await put(local, { skillOverrides: { review: 'off', deploy: 'name-only' }, apiKey: 'a-secret-value', custom: { nested: [1, 2] } });
    expect((await readSkillSettings(ctx, user)).enabled('skill-folder', content)).toBe(false);
    await expect(setSkillSetting(ctx, user, { name: 'review', content, scope: 'user' }, true, state)).rejects.toMatchObject({ code: 'SKILL_SETTING_OVERRIDDEN' });
    expect((await json(userFile)).skillOverrides.review).toBe('off');
    expect((await setSkillSetting(ctx, user, { name: 'skill-folder', content, scope: 'project' }, true, state)).success).toBe(true);
    expect(await json(local)).toEqual({ skillOverrides: { review: 'on', deploy: 'name-only' }, apiKey: 'a-secret-value', custom: { nested: [1, 2] } });
    expect((await json(shared)).skillOverrides.review).toBe('on');
    expect((await readSkillSettings(ctx, user)).enabled('review', content)).toBe(true);
  });

  it('creates missing user settings without inventing a project scope and avoids repeat writes', async () => {
    const ctx = context('claude', false);
    const input = { name: 'review', content, scope: 'user' as const };
    expect((await setSkillSetting(ctx, user, input, false, state)).success).toBe(true);
    expect(await json(path.join(user, 'settings.json'))).toEqual({ skillOverrides: { review: 'off' } });
    expect((await setSkillSetting(ctx, user, input, false, state)).applyEffect).toContain('未重复写入');
    await expect(readdir(path.join(state, 'config-backups'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(setSkillSetting(ctx, user, { ...input, scope: 'project' }, true, state)).rejects.toMatchObject({ code: 'EXTENSION_SCOPE_UNSUPPORTED' });
  });

  it('honors Droid ledger union and refuses an enable that another scope still blocks', async () => {
    const ctx = context('droid');
    const userFile = path.join(user, 'settings.json');
    const projectFile = path.join(project, '.factory/settings.json');
    await put(userFile, { disabledSkills: ['review', 'deploy'], secret: 'keep-me', other: { enabled: true } });
    await put(projectFile, { disabledSkills: ['review'] });
    await expect(setSkillSetting(ctx, user, { name: 'review', content, scope: 'user' }, true, state)).rejects.toMatchObject({ code: 'SKILL_STILL_DISABLED' });
    expect((await json(userFile)).disabledSkills).toEqual(['review', 'deploy']);
    await put(projectFile, { disabledSkills: [] });
    expect((await setSkillSetting(ctx, user, { name: 'review', content, scope: 'user' }, true, state)).success).toBe(true);
    expect(await json(userFile)).toEqual({ disabledSkills: ['deploy'], secret: 'keep-me', other: { enabled: true } });
    expect((await readSkillSettings(ctx, user)).enabled('review', content)).toBe(true);
  });

  it('does not claim to restore a Droid skill whose own frontmatter disables it', async () => {
    const ctx = context('droid');
    const disabledContent = content.replace('name: review', 'name: review\nenabled: false');
    expect((await readSkillSettings(ctx, user)).enabled('review', disabledContent)).toBe(false);
    await expect(setSkillSetting(ctx, user, { name: 'review', content: disabledContent, scope: 'user' }, true, state)).rejects.toMatchObject({ code: 'SKILL_STILL_DISABLED' });
    await expect(readFile(path.join(user, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns unknown for ambiguous relevant metadata instead of guessing native enabled state', async () => {
    const ctx = context('droid');
    const ambiguous = '---\nname: review\nenabled: *shared-default\n---\nInstructions\n';
    const settings = await readSkillSettings(ctx, user);
    expect(settings.enabled('review', ambiguous)).toBeUndefined();
    expect(settings.diagnostics).toHaveLength(1);
    await expect(setSkillSetting(ctx, user, { name: 'review', content: ambiguous, scope: 'user' }, false, state)).rejects.toMatchObject({ code: 'SKILL_METADATA_UNSUPPORTED' });
    await expect(readFile(path.join(user, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses unsupported YAML identity syntax instead of writing an override for the folder name', async () => {
    const ctx = context('claude', false);
    const file = path.join(user, 'settings.json');
    const existing = { skillOverrides: { 'folder-name': 'on', untouched: 'name-only' }, token: 'preserve-me' };
    await put(file, existing);
    for (const frontmatter of [
      '{name: actual-skill, description: valid-flow-yaml}',
      '? name\n: actual-skill',
      '"na\\u006de": actual-skill',
      "'name': actual-skill",
      '<<: {name: actual-skill}',
      '&identity\nname: actual-skill',
      '!!map\nname: actual-skill',
      '- name: actual-skill',
      '  name: actual-skill',
      'description: "multiline\nname: actual-skill\n"',
    ]) {
      const unsupported = `---\n${frontmatter}\n---\nInstructions\n`;
      expect((await readSkillSettings(ctx, user)).enabled('folder-name', unsupported)).toBeUndefined();
      await expect(setSkillSetting(ctx, user, { name: 'folder-name', content: unsupported, scope: 'user' }, false, state)).rejects.toMatchObject({ code: 'SKILL_METADATA_UNSUPPORTED' });
    }
    expect(await json(file)).toEqual(existing);
    await expect(readdir(path.join(state, 'config-backups'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the folder name only when simple block metadata clearly omits a top-level name', async () => {
    const ctx = context('claude', false);
    const withoutName = '---\ndescription: |\n  Review changes.\n  name: description-only\nmetadata:\n  name: nested-only\n  tags:\n    - review\n    - docs\n---\nInstructions\n';
    expect((await setSkillSetting(ctx, user, { name: 'folder-name', content: withoutName, scope: 'user' }, false, state)).success).toBe(true);
    expect(await json(path.join(user, 'settings.json'))).toEqual({ skillOverrides: { 'folder-name': 'off' } });
    expect((await readSkillSettings(ctx, user)).enabled('folder-name', withoutName)).toBe(false);
  });

  it('rejects linked settings and linked settings directories without touching the target', async () => {
    const outside = path.join(root, 'outside.json');
    await put(outside, { token: 'never-expose', skillOverrides: {} });
    await symlink(outside, path.join(user, 'settings.json'));
    const settings = await readSkillSettings(context('claude'), user);
    expect(settings.enabled('review', content)).toBeUndefined();
    expect(settings.diagnostics.join(' ')).not.toContain('never-expose');
    await expect(setSkillSetting(context('claude'), user, { name: 'review', content, scope: 'user' }, false, state)).rejects.toMatchObject({ code: 'INVALID_SKILL_SETTINGS' });
    await rm(path.join(user, 'settings.json'));
    const linked = path.join(root, 'linked-project-settings');
    await mkdir(linked);
    await symlink(linked, path.join(project, '.claude'));
    await expect(setSkillSetting(context('claude'), user, { name: 'review', content, scope: 'project' }, false, state)).rejects.toMatchObject({ code: 'INVALID_SKILL_SETTINGS' });
    expect(await json(outside)).toEqual({ token: 'never-expose', skillOverrides: {} });
    expect(await readdir(linked)).toEqual([]);
  });

  it('keeps invalid settings intact and does not expose parser excerpts or silently recover', async () => {
    const file = path.join(user, 'settings.json');
    const broken = '{"apiKey":"secret-no-excerpts", "skillOverrides":';
    await writeFile(file, broken);
    const settings = await readSkillSettings(context('claude'), user);
    expect(settings.enabled('review', content)).toBeUndefined();
    expect(settings.diagnostics.join(' ')).not.toContain('secret-no-excerpts');
    await expect(setSkillSetting(context('claude'), user, { name: 'review', content, scope: 'user' }, false, state)).rejects.toMatchObject({ code: 'INVALID_SKILL_SETTINGS' });
    expect(await readFile(file, 'utf8')).toBe(broken);
  });

  it('uses a hash guard so an external settings edit wins without losing unknown fields', async () => {
    const file = path.join(user, 'settings.json');
    await put(file, { skillOverrides: {}, token: 'old-secret' });
    const original = configDocuments.atomicWriteConfigDocument;
    vi.spyOn(configDocuments, 'atomicWriteConfigDocument').mockImplementationOnce(async input => {
      await put(file, { skillOverrides: { deploy: 'off' }, token: 'new-secret', external: true });
      return original(input);
    });
    await expect(setSkillSetting(context('claude'), user, { name: 'review', content, scope: 'user' }, false, state)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
    expect(await json(file)).toEqual({ skillOverrides: { deploy: 'off' }, token: 'new-secret', external: true });
  });
});
