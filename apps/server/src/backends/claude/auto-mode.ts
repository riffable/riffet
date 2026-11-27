import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeBackendOption } from '../../../../../packages/contracts/src/index.js';
import { atomicWritePrivateFile } from '../../settings/private-file.js';
import type { NativeBackendProfileConfig } from '../types.js';
import { CLAUDE_PERMISSIONS } from './launch.js';

const FILE = 'claude-auto-mode.json';

const UNCHECKED_AUTO: NativeBackendOption = {
  ...CLAUDE_PERMISSIONS.find(option => option.id === 'auto')!,
  description: 'Asks before most actions: the gateway blocks its check',
  tone: 'warning',
};

interface Seen { endpoint: string; at: string }

/**
 * Profiles on which Claude Code reported that auto mode can't check actions, so that their Auto option says so before
 * it is chosen again. Kept per profile with a hash of where its requests go, and forgotten when that changes or the
 * profile is gone: a fixed gateway is learnt again only by trying.
 */
export class ClaudeAutoModeChecks {
  private seen?: Record<string, Seen>;

  constructor(private readonly stateDir?: string) {}

  note(profile: NativeBackendProfileConfig, exists: (profileId: string) => boolean): void {
    const endpoint = endpointOf(profile);
    const seen = this.read();
    if (seen[profile.id]?.endpoint === endpoint) return;
    const kept = Object.fromEntries(Object.entries(seen).filter(([id]) => id !== profile.id && exists(id)));
    this.write({ ...kept, [profile.id]: { endpoint, at: new Date().toISOString() } });
  }

  unchecked(profile: NativeBackendProfileConfig): boolean {
    const entry = this.read()[profile.id];
    return entry !== undefined && entry.endpoint === endpointOf(profile);
  }

  /** The permission modes as the picker shows them for `profile`. */
  permissions(profile: NativeBackendProfileConfig): NativeBackendOption[] {
    return this.unchecked(profile) ? CLAUDE_PERMISSIONS.map(option => option.id === 'auto' ? UNCHECKED_AUTO : option) : CLAUDE_PERMISSIONS;
  }

  private read(): Record<string, Seen> {
    if (this.seen) return this.seen;
    this.seen = {};
    if (!this.stateDir) return this.seen;
    try {
      const parsed = JSON.parse(readFileSync(join(this.stateDir, FILE), 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [id, entry] of Object.entries(parsed as Record<string, Partial<Seen>>)) {
          if (typeof entry?.endpoint === 'string' && typeof entry.at === 'string') this.seen[id] = { endpoint: entry.endpoint, at: entry.at };
        }
      }
    } catch { /* absent or unreadable: nothing seen yet */ }
    return this.seen;
  }

  private write(seen: Record<string, Seen>): void {
    this.seen = seen;
    if (!this.stateDir) return;
    try { atomicWritePrivateFile(join(this.stateDir, FILE), `${JSON.stringify(seen, null, 2)}\n`); }
    catch { /* kept in memory; the next fallback writes it again */ }
  }
}

/** Where the profile sends requests, hashed: an endpoint may carry credentials in its URL. */
function endpointOf(profile: NativeBackendProfileConfig): string {
  const { apiEndpoint, modelSource } = profile.config;
  return createHash('sha256').update(JSON.stringify([apiEndpoint ?? null, modelSource ?? null])).digest('hex');
}
