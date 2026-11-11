import type { TuiScreenMarkers } from './types.js';
import { claudeCodeScreenMarkers } from './claude-code.js';

/** Every CLI whose terminal UI a core backend drives. Protocol-only backends are absent by design. */
export type CliId = 'claude-code';

const screenMarkers: Record<CliId, TuiScreenMarkers> = {
  'claude-code': claudeCodeScreenMarkers,
};

/**
 * Composer-ready / busy regexes for a CLI a backend puppets through a terminal. Claude Code takes
 * its argv from a generated hook settings overlay and reads its transcript through
 * `backends/claude/history.ts`, so only the screen markers are looked up by id.
 */
export function getScreenMarkers(id: CliId): TuiScreenMarkers {
  return screenMarkers[id];
}
