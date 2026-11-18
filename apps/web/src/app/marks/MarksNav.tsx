import type { ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import {
  IconBookmark,
  IconBot,
  IconChevronDown,
  IconCircleAlert,
  IconFileText,
  IconFolder,
  IconHighlighter,
  IconImage,
  IconMessageSquareText,
} from '@/components/icons';
import { AgentLogo } from '@/components/AgentLogo';
import { ListRow } from '@/components/ui/list-row';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { agentMarkStyle, useBackendLabel } from '@/lib/backends';
import type { ProjectRecord } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { MarkTab } from './marksHelpers';

interface TabItem {
  value: MarkTab;
  label: string;
  icon: ReactNode;
  warn?: boolean;
}

function useTabItems(): TabItem[] {
  const { t } = useLingui();
  return [
    { value: 'all', label: t`全部`, icon: <IconBookmark /> },
    { value: 'message', label: t({ message: '回复', context: 'marks-replies-tab' }), icon: <IconMessageSquareText /> },
    { value: 'span', label: t({ message: '高亮', context: 'marks-highlights-tab' }), icon: <IconHighlighter /> },
    { value: 'image', label: t({ message: '图片', context: 'marks-images-tab' }), icon: <IconImage /> },
    { value: 'file', label: t({ message: '文件', context: 'marks-files-tab' }), icon: <IconFileText /> },
    { value: 'orphaned', label: t`找不到原文`, icon: <IconCircleAlert />, warn: true },
  ];
}

export interface MarksNavProps {
  tab: MarkTab;
  projectId: string;
  backendId: NativeBackendId | '';
  projects: ProjectRecord[];
  backends: NativeBackendCatalogEntry[];
  onTab: (tab: MarkTab) => void;
  onProject: (projectId: string) => void;
  onBackend: (backendId: NativeBackendId | '') => void;
}

/**
 * In-page contents column (patterns.md §1.4 页内导航): same level and surface as the board,
 * aligned with the content heading, hidden below `lg`.
 */
export function MarksAside({ tab, projectId, backendId, projects, backends, onTab, onProject, onBackend }: MarksNavProps) {
  const { t } = useLingui();
  const labelOf = useBackendLabel();
  const tabs = useTabItems();
  return (
    <nav aria-label={t`筛选收藏`} className="hidden w-56 shrink-0 flex-col gap-5 overflow-y-auto px-3 pb-10 pt-9 lg:flex">
      <div className="flex flex-col gap-px">
        {tabs.map((item) => (
          <ListRow
            key={item.value}
            leading={<span className={cn(item.warn && tab === item.value && 'text-warning')}>{item.icon}</span>}
            selected={tab === item.value}
            aria-current={tab === item.value ? 'page' : undefined}
            onClick={() => onTab(item.value)}
          >
            {item.label}
          </ListRow>
        ))}
      </div>

      {projects.length > 0 && (
        <div className="flex flex-col gap-px">
          <h3 className="px-2.5 pb-1 text-2xs font-medium text-fg-4"><Trans>项目</Trans></h3>
          <ListRow
            leading={<IconFolder />}
            selected={projectId === ''}
            aria-current={projectId === '' ? 'page' : undefined}
            onClick={() => onProject('')}
          >
            <Trans>全部项目</Trans>
          </ListRow>
          {projects.map((project) => (
            <ListRow
              key={project.id}
              leading={<IconFolder />}
              selected={projectId === project.id}
              aria-current={projectId === project.id ? 'page' : undefined}
              onClick={() => onProject(project.id)}
            >
              {project.name}
            </ListRow>
          ))}
        </div>
      )}

      {backends.length > 1 && (
        <div className="flex flex-col gap-px">
          <h3 className="px-2.5 pb-1 text-2xs font-medium text-fg-4">Agent</h3>
          <ListRow
            leading={<IconBot />}
            selected={backendId === ''}
            aria-current={backendId === '' ? 'page' : undefined}
            onClick={() => onBackend('')}
          >
            <Trans>全部 Agent</Trans>
          </ListRow>
          {backends.map((entry) => (
            <ListRow
              key={entry.backendId}
              leading={<AgentLogo backend={entry.backendId} size={14} style={agentMarkStyle(entry.backendId)} />}
              selected={backendId === entry.backendId}
              aria-current={backendId === entry.backendId ? 'page' : undefined}
              onClick={() => onBackend(entry.backendId)}
            >
              {labelOf(entry.backendId)}
            </ListRow>
          ))}
        </div>
      )}
    </nav>
  );
}

/** Below `lg` (and on phones) the scope tree folds into a clean trigger beside the page title. */
export function MarksScopeMenu({ tab, projectId, backendId, projects, backends, onTab, onProject, onBackend }: MarksNavProps) {
  const { t } = useLingui();
  const labelOf = useBackendLabel();
  const tabs = useTabItems();
  const currentTab = tabs.find((item) => item.value === tab)?.label ?? t`全部`;
  const currentProject = projects.find((item) => item.id === projectId)?.name;
  const currentBackend = backendId ? labelOf(backendId) : undefined;
  const summary = [currentTab, currentProject, currentBackend].filter(Boolean).join(' · ');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="ml-1 flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-sm text-fg-2 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus lg:hidden no-hover:min-h-11">
        <span className="min-w-0 truncate">{summary}</span>
        <IconChevronDown className="size-3.5 shrink-0 text-fg-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[min(70dvh,560px)] w-64 overflow-y-auto">
        <DropdownMenuRadioGroup value={tab} onValueChange={(value) => onTab(value as MarkTab)}>
          {tabs.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              <span className={cn('contents', item.warn && 'text-warning')}>{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        {projects.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel><Trans>项目</Trans></DropdownMenuLabel>
            <DropdownMenuRadioGroup value={projectId} onValueChange={onProject}>
              <DropdownMenuRadioItem value=""><Trans>全部项目</Trans></DropdownMenuRadioItem>
              {projects.map((project) => (
                <DropdownMenuRadioItem key={project.id} value={project.id}>
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}

        {backends.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Agent</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={backendId} onValueChange={(value) => onBackend(value as NativeBackendId | '')}>
              <DropdownMenuRadioItem value=""><Trans>全部 Agent</Trans></DropdownMenuRadioItem>
              {backends.map((entry) => (
                <DropdownMenuRadioItem key={entry.backendId} value={entry.backendId}>
                  <AgentLogo backend={entry.backendId} size={14} style={agentMarkStyle(entry.backendId)} />
                  <span className="min-w-0 flex-1 truncate">{labelOf(entry.backendId)}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
