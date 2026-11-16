import { sweepOrphanTmuxServers } from '../apps/server/src/terminal/orphans.js';

/**
 * After the run, ends the tmux servers tests left that nobody can reach (docs/guide/performance.md
 * §3.10): a test that removed its temp directory took the socket with it, and a test worker that
 * exited leaves its temp state directory's server without an owner. The service's own sweep would end
 * them too, but only where a service is running.
 */
export async function teardown(): Promise<void> {
  const ended = await sweepOrphanTmuxServers({ graceMs: 0 });
  if (ended.length) console.info(`[tests] ended ${ended.length} orphaned tmux server(s)`);
}
