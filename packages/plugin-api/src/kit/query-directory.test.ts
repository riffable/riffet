import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryDirectory } from './query-directory.js';

vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }));

let root: string;
let cache: string;
const profile = { backendId: 'codex', id: 'local' };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'riffet-query-directory-')));
  vi.mocked(homedir).mockReturnValue(root);
  vi.stubEnv('XDG_CACHE_HOME', '');
  cache = process.platform === 'darwin' ? join(root, 'Library', 'Caches') : join(root, '.cache');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('queryDirectory', () => {
  it('uses the canonical cache spelling when an existing app directory has different case', async () => {
    await mkdir(join(cache, 'Riffet'), { recursive: true });
    const directory = await queryDirectory(undefined, profile);
    expect(directory).toBe(await realpath(directory));
    expect(dirname(dirname(directory))).toBe(await realpath(join(cache, 'riffet')));
  });

  it('rejects a symlink in a query directory ancestor', async () => {
    await mkdir(cache, { recursive: true });
    const target = join(root, 'elsewhere');
    await mkdir(target);
    await symlink(target, join(cache, 'riffet'), 'dir');
    await expect(queryDirectory(undefined, profile)).rejects.toMatchObject({ code: 'NATIVE_QUERY_DIRECTORY_UNAVAILABLE' });
  });

  it('rejects a query directory replaced with a symlink', async () => {
    const directory = await queryDirectory(undefined, profile);
    const target = join(root, 'elsewhere');
    await mkdir(target);
    await rm(directory, { recursive: true });
    await symlink(target, directory, 'dir');
    await expect(queryDirectory(undefined, profile)).rejects.toMatchObject({ code: 'NATIVE_QUERY_DIRECTORY_UNAVAILABLE' });
  });
});
