// Declarative description of the CLI-specific details a TUI-driving backend needs.
//
// Layering: `src/backends/` is the provider seam, one driver per CLI, each owning its own
// transport (Codex's app-server, Claude's hooks + JSONL, DSH's RPC bridge). This directory sits
// *below* that seam and holds only the screen details of a terminal UI a core driver puppets, so a
// regex has one home. A driver that speaks a structured protocol (Codex, DSH) needs nothing from here.
// Plugins (Cursor) own their CLI adapter.

/**
 * How one CLI's terminal UI announces that it is ready for input versus mid-turn. Claude Code
 * takes its authoritative status from hooks and uses these markers purely as a screen-level cross-check.
 */
export interface TuiScreenMarkers {
  /** Composer-ready regex. The TUI prints this once the input box accepts text. */
  readonly readyPattern: RegExp;
  /** The CLI's own working/busy marker. Appears while a turn is executing. */
  readonly busyPattern: RegExp;
}
