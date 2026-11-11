# Contributing

## Setup

Requires Node.js >= 24.19 and pnpm.

```bash
pnpm install
pnpm dev        # server
pnpm dev:web    # web client with hot reload
```

Native clients live in `apps/macos` (Xcode, XcodeGen) and `apps/mobile` (Gradle for Android, Xcode for iOS); see [docs/MACOS.md](docs/MACOS.md) and [docs/MOBILE.md](docs/MOBILE.md).

## Checks

Run before opening a pull request:

```bash
pnpm typecheck
pnpm test
pnpm check:plugins
pnpm check:compose        # when touching mobile Compose code
pnpm build
```

CI also verifies the generated files (`pnpm gen:*:check`), i18n and contract snapshots; run the matching `pnpm gen:*` script when your change affects them. The full list is in `.github/workflows/ci.yml`.

## Conventions

Code and documentation conventions are in [AGENTS.md](AGENTS.md). Keep changes focused, reuse existing dependencies and components, and add tests only for core behavior.

## Releasing to npm

The `riffet` package is `dist/` plus the launcher, with the runtime dependencies `pnpm build` records in `dist/runtime-package.json`. Build from a clean checkout of the release tag so the build identity matches, then stage and inspect the package:

```bash
RIFFET_PUBLIC_BUILD=1 pnpm build      # add RIFFET_EXCLUDED_VENDORS=<vendor> to leave a built-in vendor out
pnpm pack:npm                         # build/npm/ and build/npm/riffet-<version>.tgz
tar tzf build/npm/riffet-*.tgz | less
```

A maintainer then runs `npm publish build/npm`. `pnpm pack:npm` refuses a build that recorded this machine's checkout path; for a vendor-excluded build also run `node scripts/check-public-artifacts.mjs build/npm` with `RIFFET_ARTIFACT_DENYLIST` set.

## License

Riffet is licensed under Apache-2.0. By submitting a contribution you agree that it is licensed under the same terms.
