## Summary

For a workbench feature, note the owner question it answers, the existing or new assistant capability, and which conversations may use it.

## Checks

- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] Generated files updated when affected (`pnpm gen:*`)
- [ ] Multi-server: classified per `docs/guide/multi-server.md`; new routes declare link handling (delete if no server or client behavior changed)

## Interface changes

Delete this section if the change has no visible interface.

- [ ] Read `docs/design/DECISIONS.md` and the matching chapter of `docs/design/system/`
- [ ] Built from existing components and patterns; a new one is specified in `docs/design/system/` and shown on the design page
- [ ] `pnpm check:design` and `pnpm check:motion` pass; new strings extracted and translated
- [ ] Compared against the design page: states, light and dark, narrow width
- [ ] Screenshots attached
