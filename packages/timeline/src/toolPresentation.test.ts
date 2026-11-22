import { describe, expect, it } from 'vitest';
import { compactDisplayPath, compactSearchQuery, describeJobRow, describeToolRow } from './toolPresentation.js';

const ROOT = '/Users/dev/workspace/riffet';

describe('describeToolRow', () => {
  it('compacts complex search queries and strips redundant scope prefixes', () => {
    expect(compactSearchQuery(`'additive|latest|tag|version'`)).toBe('additive|latest…');
    expect(compactSearchQuery(`\\b(decideProcessFold|canReleaseDeferredProcessFold)\\b`)).toBe('decideProcessFold|canR…');

    const rgChained = describeToolRow({
      kind: 'execute',
      rawInput: { command: `rg -n 'additive|latest|tag|version' scripts/gen-contracts.ts | tail -35; git config --get core.hooksPath; git tag --list` },
    }, 'Tool', ROOT);
    expect(rgChained).toMatchObject({
      icon: 'search',
      verb: 'Search',
      primary: 'additive|latest…',
      secondary: 'gen-contracts.ts',
      extraCommands: 2,
    });

    const nativeGrep = describeToolRow({
      kind: 'search',
      title: 'grep useTranscriptScroll',
      locations: [{ path: `${ROOT}/apps/web/src/app/session` }],
    }, 'Tool', ROOT);
    expect(nativeGrep).toMatchObject({
      icon: 'search',
      verb: 'Search',
      primary: 'useTranscriptScroll',
      secondary: 'app/session',
    });

    const globAll = describeToolRow({
      kind: 'search',
      toolName: 'Glob',
      rawInput: { glob_pattern: '*', target_directory: `${ROOT}/apps/mobile/client/src/commonMain/kotlin/riffet/ui/timeline` },
    }, 'Tool', ROOT);
    expect(globAll).toMatchObject({
      icon: 'read',
      verb: 'List',
      primary: 'ui/timeline',
      primaryKind: 'code',
    });

    const rgFiles = describeToolRow({
      kind: 'execute',
      rawInput: { command: 'rg --files apps/server/src/backends/claude' },
    }, 'Tool', ROOT);
    expect(rgFiles).toMatchObject({
      icon: 'read',
      verb: 'List',
      primary: 'backends/claude',
      primaryKind: 'code',
    });

    const sqlite = describeToolRow({
      kind: 'execute',
      rawInput: { command: 'sqlite3 /Users/dev/.local/share/riffet/workbench.db "SELECT id, title FROM sessions LIMIT 5"' },
    }, 'Tool', ROOT);
    expect(sqlite).toMatchObject({
      icon: 'execute',
      verb: 'Run',
      prefix: 'sqlite3',
      primary: '~/.local/…/riffet/workbench.db',
      primaryKind: 'path',
    });
  });

  it('applies the 5-tier inline script rules for python3 and node', () => {
    // Tier 1: observed file edits upgrade to Edit with affected files
    const edited = describeToolRow({
      kind: 'execute',
      rawInput: { command: "python3 - <<'PY'\nfrom pathlib import Path\nPY" },
      content: [
        { type: 'diff', path: `${ROOT}/CHANGELOG.md`, oldText: 'a', newText: 'b' },
        { type: 'diff', path: `${ROOT}/CHANGELOG.zh-CN.md`, oldText: 'a', newText: 'b' },
      ],
    }, 'Tool', ROOT);
    expect(edited).toMatchObject({
      icon: 'edit',
      verb: 'Edit',
      prefix: 'python3',
      primary: 'CHANGELOG.md, CHANGELOG.zh-CN.md',
    });

    // Tier 2: leading comment
    const commented = describeToolRow({
      kind: 'execute',
      rawInput: { command: "python3 - <<'PY'\n# Verify release tarball excludes internal paths\nimport tarfile\nPY" },
    }, 'Tool', ROOT);
    expect(commented).toMatchObject({
      icon: 'execute',
      verb: 'Run',
      prefix: 'python3',
      primary: 'Verify release tarball excludes internal paths',
      primaryKind: 'prose',
    });

    // Tier 3: static scan of file references
    const scanned = describeToolRow({
      kind: 'execute',
      rawInput: { command: "python3 - <<'PY'\nimport json, pathlib\ncat = json.loads(pathlib.Path('apps/macos/Riffet/Resources/Localizable.xcstrings').read_text())\nPY" },
    }, 'Tool', ROOT);
    expect(scanned).toMatchObject({
      icon: 'execute',
      verb: 'Run',
      prefix: 'python3',
      primary: 'apps/macos/Riffet/Resources/Localizable.xcstrings',
      primaryKind: 'path',
    });

    // Tier 3 on node -e
    const nodeInline = describeToolRow({
      kind: 'execute',
      rawInput: { command: `node -e "const fs = require('fs'); console.log(fs.readFileSync('packages/contracts/package.json', 'utf8'))"` },
    }, 'Tool', ROOT);
    expect(nodeInline).toMatchObject({
      icon: 'execute',
      verb: 'Run',
      prefix: 'node',
      primary: 'packages/contracts/package.json',
      primaryKind: 'path',
    });

    // Tier 4: short one-liner
    const shortOne = describeToolRow({
      kind: 'execute',
      rawInput: { command: `python3 -c "import time; print(int(time.time()))"` },
    }, 'Tool', ROOT);
    expect(shortOne).toMatchObject({
      icon: 'execute',
      verb: 'Run',
      prefix: 'python3',
      primary: 'print(int(time.time()))',
    });

    // Tier 5: fallback line count
    const fallback = describeToolRow({
      kind: 'execute',
      rawInput: { command: "python3 - <<'PY'\na = 1\nb = 2\nc = a + b\nprint(c)\nPY" },
    }, 'Tool', ROOT);
    expect(fallback).toMatchObject({
      icon: 'execute',
      verb: 'Run',
      primary: 'python3',
      lineCount: 4,
    });
  });

  it('normalizes git, gh api polling, runners, outside paths and multi-agent tools', () => {
    const merge = describeToolRow({
      kind: 'execute',
      rawInput: { command: `git fetch --quiet --no-tags . refs/heads/main && git merge --no-edit FETCH_HEAD` },
    }, 'Tool', ROOT);
    expect(merge).toMatchObject({ icon: 'git', verb: 'Git', primary: 'merge', secondary: 'main', extraCommands: 1 });

    const gh1 = describeToolRow({
      kind: 'execute',
      rawInput: { command: `gh api repos/riffable/riffet/actions/runs/44989512781/jobs --jq '.jobs[]'` },
    }, 'Tool', ROOT);
    const gh2 = describeToolRow({
      kind: 'execute',
      rawInput: { command: `gh api repos/riffable/riffet/actions/runs/44989512777/jobs --jq '.jobs[]'` },
    }, 'Tool', ROOT);
    expect(gh1.mergeKey).toBe('gh-api:actions/runs/…/jobs');
    expect(gh2.mergeKey).toBe(gh1.mergeKey);
    expect(gh1.mergedSecondary).toBe('actions/runs/…/jobs');

    const build = describeToolRow({
      kind: 'execute',
      rawInput: { command: `RIFFET_PUBLIC_BUILD=1 pnpm build > /tmp/riffet-release-0.10.0.QkaHBlRC/public-build.log 2>&1 && pnpm pack --pack-destination /tmp/out` },
    }, 'Tool', ROOT);
    expect(build).toMatchObject({ icon: 'execute', verb: 'Run', primary: 'pnpm build', extraCommands: 1 });

    expect(compactDisplayPath('/Users/dev/.cursor/projects/Users-dev-workspace-riffet/terminals/426378.txt', ROOT))
      .toBe('~/.cursor/…/terminals/426378.txt');
    expect(compactDisplayPath('/tmp/riffet-release-0.10.0.QkaHBlRC/pack.log', ROOT))
      .toBe('/tmp/…/pack.log');

    const readLines = describeToolRow({
      kind: 'read',
      title: 'Read ingest.test.ts lines 155-194',
      locations: [{ path: `${ROOT}/apps/server/src/journal/ingest.test.ts` }],
    }, 'Tool', ROOT);
    expect(readLines).toMatchObject({
      icon: 'read',
      verb: 'Read',
      primary: 'apps/server/src/journal/ingest.test.ts',
      lineRange: 'L155–194',
    });

    const fetchZh = describeToolRow({
      kind: 'fetch',
      title: '抓取 https://docs.anthropic.com/en/docs/claude-code/hooks',
    }, 'Tool', ROOT);
    expect(fetchZh).toMatchObject({
      icon: 'fetch',
      verb: 'Fetch',
      primary: 'docs.anthropic.com',
      secondary: '/en/docs/claude-code/hooks',
    });

    const mcp = describeToolRow({
      kind: 'other',
      toolName: 'mcp__plugin_riffet_tools__browser_snapshot',
      rawInput: { url: 'http://localhost:5173/design' },
    }, 'Tool', ROOT);
    expect(mcp).toMatchObject({
      icon: 'mcp',
      verb: 'MCP',
      primary: 'browser · snapshot',
      secondary: 'localhost:5173/design',
    });

    const claudeDesc = describeToolRow({
      kind: 'execute',
      title: 'Run all ingest-contract suites, sync test, modules, and typecheck',
      rawInput: {
        command: 'npx vitest run apps/server/src/journal && pnpm typecheck',
        description: 'Run all ingest-contract suites, sync test, modules, and typecheck',
      },
    }, 'Tool', ROOT);
    expect(claudeDesc).toMatchObject({
      icon: 'execute',
      verb: 'Run',
      primary: 'Run all ingest-contract suites, sync test, modules, and typecheck',
      primaryKind: 'prose',
    });

    const gradleJob = describeJobRow(
      `./gradlew :client:jvmTest --tests "riffet.ui.timeline.TimelineRowsTest" :shared:compileCommonMainKotlinMetadata`,
      `./gradlew :client:jvmTest --tests "riffet.ui.timeline.TimelineRowsTest" :shared:compileCommonMainKotlinMetadata`,
      ROOT,
    );
    expect(gradleJob).toMatchObject({
      icon: 'execute',
      verb: 'Run',
      primary: 'gradlew :client:jvmTest',
      secondary: 'TimelineRowsTest',
      extraCommands: 1,
    });

    const verifyJob = describeJobRow(
      `pnpm verify packages/timeline/src/toolTitle.ts apps/web/src/app/session/transcriptRows.ts apps/web/src/app/session/Timeline.tsx`,
      `pnpm verify packages/timeline/src/toolTitle.ts apps/web/src/app/session/transcriptRows.ts apps/web/src/app/session/Timeline.tsx`,
      ROOT,
    );
    expect(verifyJob).toMatchObject({
      icon: 'execute',
      verb: 'Run',
      primary: 'pnpm verify',
      secondary: 'packages/timeline/src/toolTitle.ts',
      extraFiles: 2,
    });
  });

  it('handles quoted operators, multiline scripts, option flags, and non-MCP dot titles', () => {
    const sqlGt = describeToolRow({
      kind: 'execute',
      rawInput: { command: 'sqlite3 workbench.db "SELECT id FROM sessions WHERE id > 5"' },
    }, 'Tool', ROOT);
    expect(sqlGt).toMatchObject({ verb: 'Run', prefix: 'sqlite3', primary: 'workbench.db', primaryKind: 'path' });

    const rgArrow = describeToolRow({
      kind: 'execute',
      rawInput: { command: "rg 'a -> b' apps/web/src/app/session/Timeline.tsx" },
    }, 'Tool', ROOT);
    expect(rgArrow).toMatchObject({ verb: 'Search', primary: 'a -> b', secondary: 'Timeline.tsx' });

    const multilinePy = describeToolRow({
      kind: 'execute',
      rawInput: { command: 'python3 -c "\n# Inspect session timeline\nprint(1 << 2)\n"' },
    }, 'Tool', ROOT);
    expect(multilinePy).toMatchObject({ verb: 'Run', prefix: 'python3', primary: 'Inspect session timeline', primaryKind: 'prose' });

    const ghPost = describeToolRow({
      kind: 'execute',
      rawInput: { command: 'gh api -X POST repos/riffable/riffet/pulls/42/comments --jq ".id"' },
    }, 'Tool', ROOT);
    expect(ghPost).toMatchObject({ verb: 'Run', primary: 'gh api', secondary: 'pulls/42/comments', mergeKey: 'gh-api:pulls/…/comments' });

    const rgFiles = describeToolRow({
      kind: 'execute',
      rawInput: { command: "rg --files -g '*.ts' apps/server/src/backends/claude" },
    }, 'Tool', ROOT);
    expect(rgFiles).toMatchObject({ verb: 'List', primary: 'backends/claude', primaryKind: 'code' });

    const planWithDot = describeToolRow({
      kind: 'plan',
      title: 'Phase 1 · Design',
    }, 'Tool', ROOT);
    expect(planWithDot).toMatchObject({ icon: 'plan', verb: 'Plan', primary: 'Phase 1 · Design' });
  });
});
