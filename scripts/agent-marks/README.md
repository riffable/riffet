# Agent marks — source files

The seven backend marks, one SVG per backend id (`cursor`, `codex`, `claude`,
`dsh`, `droid`, `trae`, `pi`). These are the vendors' own logo files, vendored so
every client renders the same geometry. `scripts/gen-agent-marks.ts` converts
them to each platform's native form (web SVG component, Compose `ImageVector`,
SwiftUI paths); never hand-edit the generated outputs, and never redraw a mark
by eye — update the source file here and re-run `pnpm gen:marks`.

| File | Backend | Source | Fetched |
|---|---|---|---|
| `cursor.svg` | Cursor | Cursor logo file via openai/agents.md public/logos/cursor.svg (cursor.com brand assets) | 2026-10-29 |
| `codex.svg` | Codex (OpenAI) | Codex logo via openai/agents.md public/logos/codex.svg | 2026-10-29 |
| `claude.svg` | Claude (Anthropic) | "Claude AI symbol" via Wikimedia Commons (CC0) | 2026-10-29 |
| `droid.svg` | Droid (Factory) | factory.ai official favicon | 2026-10-29 |
| `dsh.svg` | DeepSeek | DeepSeek whale via @lobehub/icons-static-svg (traced from DeepSeek's mark) | 2026-10-29 |
| `trae.svg` | TRAE (ByteDance) | TRAE pixel mark via @lobehub/icons-static-svg (from trae.ai assets) | 2026-10-29 | <!-- privacy: allow public vendor attribution -->
| `pi.svg` | pi | pi logo mark from pi.dev `logo-auto.svg` | 2026-11-01 |

## Usage rules

- The marks belong to their owners. They are used only to identify which
  backend a session, picker or service row refers to — never as Riffet
  branding, never more prominently than Riffet's own mark.
- Codex keeps its shipped gradient; pi keeps the three colours of its shipped
  mark. Other marks render monochrome in the platform's agent colour (web
  `--agent-*`, Android/macOS palette roles); where a vendor ships only a
  fixed-colour mark, the brand colour in `gen-agent-marks.ts` is the fallback.
  DeepSeek's brand guidelines ask that the mark not be modified — prefer the
  original blue on formal surfaces.
- Three backends have no `--agent-*` palette role yet (droid, trae, pi). Their
  fallback colours live in the generator; adding palette roles belongs in
  `apps/web/src/styles/index.css` plus a `pnpm gen:theme` run, not here.
