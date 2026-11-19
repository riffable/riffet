import type { NativeSlashItem, Project } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import { referencedSkills, slashTokens } from '../shared/slash-tokens.js';
import { queryDirectory } from '../shared/query-directory.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { standingSkill, useStandingSkillRoots, type CodexStanding } from './standing.js';
import { asArray, asRecord, str } from './util.js';

interface SkillsContext {
  /** Looked up on each call: the adapter's reader of a live or short-lived app-server. */
  withTransport<T>(project: Project | undefined, profile: NativeBackendProfileConfig, session: undefined, read: (transport: CodexAppServerClient) => Promise<T>): Promise<T>;
  standingOf(host: NativeBackendHost, project: Project): CodexStanding | undefined;
}

/**
 * The skills the app-server reports, as slash items and as the structured inputs a message needs to
 * invoke them. It owns the names last confirmed per directory and profile; it does not own the
 * transport that reads them.
 */
export class CodexSkills {
  /** Last confirmed skill names distinguish inline invocations from prose during a catalog outage. */
  private readonly known = new Map<string, Set<string>>();

  constructor(private readonly ctx: SkillsContext) {}

  async slashItems(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<NativeSlashItem[]> {
    const cwd = await queryDirectory(project, profile);
    const standing = project && this.ctx.standingOf(host, project);
    const items = await this.ctx.withTransport(project, profile, undefined, async transport => {
      if (standing) await useStandingSkillRoots(transport, standing);
      return await listSkills(transport, cwd, standing);
    });
    this.remember(cwd, profile, items);
    return items;
  }

  private remember(cwd: string, profile: NativeBackendProfileConfig, skills: NativeSlashItem[]): void {
    const key = JSON.stringify([cwd, profile.id, profile.config]);
    const names = this.known.get(key) ?? new Set<string>();
    for (const skill of skills) names.add(skill.name);
    this.known.delete(key);
    this.known.set(key, names);
    if (this.known.size > 64) this.known.delete(this.known.keys().next().value!);
  }

  /**
   * The app-server only loads a skill handed to it as a structured input item; `/name` in the text
   * is just prose to it. Each token naming an enabled skill becomes one, wherever it sits, and the
   * text is left as typed. A failed lookup must not silently drop an invoked skill.
   */
  async inputs(transport: CodexAppServerClient | undefined, cwd: string, profile: NativeBackendProfileConfig, text: string, strictSteer = false, standing?: CodexStanding): Promise<unknown[]> {
    const tokens = slashTokens(text);
    const leading = tokens.find(token => token.start === text.length - text.trimStart().length);
    const rejectCommand = () => new AppError('STEER_REJECTED', 'Steering accepts only messages or enabled skills; use the matching conversation action for CLI commands.', 409);
    const unavailable = () => strictSteer ? rejectCommand() : new AppError('NATIVE_SKILL_CATALOG_UNAVAILABLE', 'Could not verify skills; refresh the skill list and try again.', 503);
    if (!tokens.length) return [];
    const known = this.known.get(JSON.stringify([cwd, profile.id, profile.config]));
    const onUnavailable = (): unknown[] => {
      if (leading || tokens.some(token => known?.has(token.name))) throw unavailable();
      return []; // An unrecognized inline API path is prose, not an asserted skill invocation.
    };
    if (!transport?.isOnline) {
      return onUnavailable();
    }
    let skills: Awaited<ReturnType<typeof listSkills>>;
    try { skills = await listSkills(transport, cwd, standing); }
    catch {
      return onUnavailable();
    }
    this.remember(cwd, profile, skills);
    // The app-server has a skills directory, but no TUI command catalog. Both send paths
    // admit a remaining leading /name only when that native directory identifies an enabled
    // skill. This rejects /model, /clear and unknown commands without maintaining a parallel list;
    // slashTokens excludes full paths such as /usr/bin; inline references remain ordinary prose.
    if (leading && !skills.some(skill => skill.name === leading.name)
      || tokens.some(token => known?.has(token.name) && !skills.some(skill => skill.name === token.name))) {
      throw strictSteer ? rejectCommand() : new AppError('NATIVE_COMMAND_UNSUPPORTED', 'This command or skill is unavailable; use the conversation controls or choose an enabled skill.', 400);
    }
    return referencedSkills(text, skills).map(skill => ({ type: 'skill', name: skill.name, path: skill.path }));
  }

}

/** The enabled skills; for the 助理, only its own (`standing.ts`), whatever else the process finds. */
export async function listSkills(transport: CodexAppServerClient, cwd: string, standing?: CodexStanding): Promise<Array<NativeSlashItem & { path: string }>> {
  const response = await transport.request<{ data?: Array<{ cwd?: string; skills?: unknown[] }> }>('skills/list', { cwds: [cwd] });
  const seen = new Set<string>();
  const items: Array<NativeSlashItem & { path: string }> = [];
  for (const entry of asArray<{ skills?: unknown[] }>(response.data)) {
    for (const skill of asArray<Record<string, unknown>>(entry.skills)) {
      const name = str(skill.name);
      const path = str(skill.path);
      if (!name || !path || (standing ? !standingSkill(path, standing) : skill.enabled === false) || seen.has(name)) continue;
      seen.add(name);
      const face = asRecord(skill.interface) ?? {};
      const description = str(face.shortDescription) ?? str(skill.shortDescription) ?? str(skill.description);
      items.push({ name, kind: 'skill', path, ...(description ? { description } : {}) });
    }
  }
  return items;
}
