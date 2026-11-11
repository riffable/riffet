import { useLingui } from '@lingui/react/macro';
import { IconCheck, IconFolder, IconFolderPlus, IconGitBranch } from '@/components/icons';
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { ProjectRecord } from '@/lib/api';
import { tildePath } from '@/lib/utils';
import { byRecentUse, FavoriteStar, favoriteName, useFolderFavorites } from '../FolderFavorites';

/**
 * The directory list a new session can start in. It lives on the composer, not on the way to it:
 * the sidebar's "new session" must stay a plain navigation step, since reaching the new-session
 * page is often all someone wanted.
 *
 * Isolation is offered here rather than as a switch on the composer because that is all it is:
 * a conversation runs where its directory points, so giving one a checkout to itself means
 * sending it to a different directory. The caller orders projects and worktrees by recent use.
 *
 * This is the menu's contents, so the caller owns the trigger and the surface.
 */
export function DirectoryMenu({ directories, selectedProjectId, isolating, onSelectProject, onSelectNoProject, onChooseDirectory, onOpenDirectory, onCreateWorktree }: {
  directories: ProjectRecord[];
  selectedProjectId: string;
  /** A worktree is being cut; the entry stays visible but cannot be triggered again. */
  isolating?: boolean;
  onSelectProject: (project: ProjectRecord) => void;
  onSelectNoProject?: () => void;
  /** Absent where only listed projects can be chosen, as is `onOpenDirectory`. */
  onChooseDirectory?: () => void;
  /** Opens a favorite folder in one step; the server stamps the favorite as used when it does. */
  onOpenDirectory?: (path: string) => void;
  onCreateWorktree?: () => void;
}) {
  const { t } = useLingui();
  const available = directories.filter((project) => !project.archivedAt);
  // A favorite that is already a listed project would only repeat its row.
  const favorites = byRecentUse(useFolderFavorites().favorites.filter((favorite) => favorite.exists && !available.some((project) => project.cwd === favorite.path)));
  const row = (project: ProjectRecord) => (
    <DropdownMenuItem key={project.id} onSelect={() => onSelectProject(project)}>
      {project.worktree ? <IconGitBranch className="size-4 text-fg-3" /> : <IconFolder className="size-4 text-fg-3" />}
      <span className="min-w-0 flex-1 truncate" title={project.worktree?.branch ?? project.name}>{project.worktree?.branch ?? project.name}</span>
      <span className="max-w-40 truncate font-mono text-2xs text-fg-3" title={project.cwd}>{tildePath(project.cwd)}</span>
      {/* The check keeps its box whether or not it is shown, so the paths stay in one column. */}
      <span className="grid size-4 shrink-0 place-items-center">{project.id === selectedProjectId && <IconCheck className="size-4 text-fg" />}</span>
    </DropdownMenuItem>
  );

  return (
    <>
      {onSelectNoProject && <>
        <DropdownMenuItem onSelect={onSelectNoProject}>
          <IconFolder className="size-4 text-fg-3" />
          <span className="min-w-0 flex-1">{t`不选择项目`}</span>
          <span className="grid size-4 shrink-0 place-items-center">{!selectedProjectId && <IconCheck className="size-4" />}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </>}
      {onCreateWorktree && (
        <DropdownMenuItem disabled={isolating} onSelect={onCreateWorktree}>
          <IconGitBranch />
          {isolating ? t`正在创建 Worktree…` : t`新建 Worktree`}
        </DropdownMenuItem>
      )}
      {onChooseDirectory && <DropdownMenuItem onSelect={onChooseDirectory}><IconFolderPlus />{t`选择其他目录…`}</DropdownMenuItem>}
      {(onCreateWorktree || onChooseDirectory) && <DropdownMenuSeparator />}
      <DropdownMenuLabel>{t`在哪个目录新建？`}</DropdownMenuLabel>
      {available.map(row)}
      {!available.length && <div className="px-2 py-1.5 text-xs text-fg-3">{t`还没有目录`}</div>}
      {onOpenDirectory && favorites.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t`收藏的目录`}</DropdownMenuLabel>
          {favorites.map((favorite) => (
            <DropdownMenuItem key={favorite.id} onSelect={() => onOpenDirectory(favorite.path)}>
              <FavoriteStar className="size-4" />
              <span className="min-w-0 flex-1 truncate">{favoriteName(favorite)}</span>
              <span className="max-w-40 truncate font-mono text-2xs text-fg-3" title={favorite.path}>{tildePath(favorite.path)}</span>
              <span className="size-4 shrink-0" />
            </DropdownMenuItem>
          ))}
        </>
      )}
    </>
  );
}
