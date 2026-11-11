import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceService } from './index.js';

const finder = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: finder.execFile,
}));

it('orders directories before files across listing pages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'riffet-files-'));
  try {
    await Promise.all([
      mkdir(path.join(root, 'z-folder')),
      mkdir(path.join(root, 'b-folder')),
      writeFile(path.join(root, 'a.txt'), ''),
      writeFile(path.join(root, 'm.txt'), ''),
    ]);
    const workspace = new WorkspaceService({ stateDir: path.join(root, '.state') });
    const pages = await Promise.all([0, 2].map(offset => workspace.files(root, { limit: 2, offset })));
    expect(pages.map(page => page.map(entry => [entry.name, entry.kind]))).toEqual([
      [['b-folder', 'directory'], ['z-folder', 'directory']],
      [['a.txt', 'file'], ['m.txt', 'file']],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('Finder file handoff', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let root: string;
  let project: string;
  let workspace: WorkspaceService;
  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    finder.execFile.mockReset().mockImplementation((_command, _args, _options, callback) => callback(null));
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'riffet-finder-')));
    project = path.join(root, 'project');
    await mkdir(project);
    await mkdir(path.join(root, 'state'));
    workspace = new WorkspaceService({ stateDir: path.join(root, 'state') });
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', platform);
    await rm(root, { recursive: true, force: true });
  });

  it('hands the file to Finder once as an argument, including shell punctuation', async () => {
    const name = '题包 $(echo unused); "v2".json';
    await writeFile(path.join(project, name), '{}');
    await expect(workspace.revealInFinder(project, name)).resolves.toEqual({ opened: true });
    expect(finder.execFile).toHaveBeenCalledTimes(1);
    expect(finder.execFile).toHaveBeenCalledWith('/usr/bin/open', ['-R', path.join(project, name)], { cwd: project, timeout: 10_000 }, expect.any(Function));
  });

  it('keeps the existing outside-file and credential restrictions before launching Finder', async () => {
    const outside = path.join(root, 'artifact.json');
    const secret = path.join(root, 'state', 'access-token');
    await writeFile(outside, '{}');
    await writeFile(secret, 'secret');
    await symlink(secret, path.join(project, 'linked-token'));
    await expect(workspace.revealInFinder(project, outside)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(workspace.revealInFinder(project, 'linked-token', { allowOutside: true })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    await expect(workspace.revealInFinder(project, secret, { allowOutside: true })).rejects.toMatchObject({ code: 'PATH_DENIED' });
    expect(finder.execFile).not.toHaveBeenCalled();
    await expect(workspace.revealInFinder(project, outside, { allowOutside: true })).resolves.toEqual({ opened: true });
    expect(finder.execFile).toHaveBeenCalledTimes(1);
  });

  it('reports a failed Finder handoff and refuses hosts without Finder', async () => {
    await writeFile(path.join(project, 'file.txt'), 'text');
    finder.execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error('open failed')));
    await expect(workspace.revealInFinder(project, 'file.txt')).rejects.toMatchObject({ code: 'FINDER_OPEN_FAILED', statusCode: 500 });
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(workspace.revealInFinder(project, 'file.txt')).rejects.toMatchObject({ code: 'FINDER_OPEN_FAILED', statusCode: 501 });
    expect(finder.execFile).toHaveBeenCalledTimes(1);
  });
});
