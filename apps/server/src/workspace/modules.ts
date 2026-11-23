import path from 'node:path';
import type { CodeModule, CodeModules } from '../../../../packages/contracts/src/index.js';
import type { Candidates } from './file-index.js';

/** Build files that mark a directory as a module of its build system; shared by code navigation and the module list. */
export const MODULE_MARKERS = new Set(['build.gradle', 'build.gradle.kts', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'Package.swift', 'pubspec.yaml', 'Podfile']);

export const isModuleMarker = (name: string): boolean => MODULE_MARKERS.has(name) || name.endsWith('.csproj');

/** The modules of a project read from its file list, so a monorepo costs no directory walk; the first marker found names a module. */
export function modulesOf(list: Candidates, projectName: string): CodeModules {
  const found = new Map<string, string>();
  for (let index = 0; index < list.dirStart; index++) {
    const file = list.paths[index]!;
    const at = file.lastIndexOf('/');
    const name = file.slice(at + 1);
    if (!isModuleMarker(name)) continue;
    const dir = at < 0 ? '' : file.slice(0, at);
    if (!found.has(dir)) found.set(dir, name);
  }
  const modules: CodeModule[] = [...found].map(([dir, marker]) => ({ path: dir, name: dir ? path.posix.basename(dir) : projectName, marker }));
  modules.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { modules };
}
