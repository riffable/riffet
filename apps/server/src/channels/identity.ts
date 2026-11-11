import { randomUUID } from 'node:crypto';
import type { ChannelBindCode, ChannelIdentity } from '../../../../packages/contracts/src/channels.js';
import { createPairingCode, redeemPairingCode } from '../pairing.js';
import type { ChannelBindings } from './bindings.js';

/*
 * Who may drive this server through a channel: only accounts bound by a one-time code that was
 * generated in the signed-in Web settings (docs/design/channels.md, 身份与安全). The code pool is
 * scoped to the account, so a device pairing code, or another app's code, never binds.
 */

const purpose = (account: string) => `channel:${account}`;

export class ChannelIdentities {
  constructor(private readonly bindings: ChannelBindings) {}

  list(): ChannelIdentity[] { return this.bindings.identities(); }
  /** Whether this platform user may use the bot of `account`. */
  isBound(account: string, userId: string): boolean { return this.bindings.identity(account, userId) !== undefined; }

  issueCode(account: string): ChannelBindCode {
    const issued = createPairingCode(undefined, purpose(account));
    return { code: issued.code, expiresAt: new Date(issued.expiresAt).toISOString() };
  }

  /** Spends the code and binds the sender; false when the code is wrong, expired or already used. */
  redeem(account: string, code: string, sender: { id: string; name?: string }): boolean {
    if (!redeemPairingCode(code, purpose(account))) return false;
    this.bindKnown(account, sender);
    return true;
  }

  /** Binds a user the platform already vouched for (the scanner of a scan-to-create); no-op when bound. */
  bindKnown(account: string, sender: { id: string; name?: string }): void {
    if (!this.isBound(account, sender.id)) this.bindings.setIdentity({ id: `id-${randomUUID().slice(0, 8)}`, account, userId: sender.id, ...(sender.name ? { name: sender.name } : {}), boundAt: new Date().toISOString() });
  }

  remove(id: string): boolean { return this.bindings.removeIdentity(id); }
}
