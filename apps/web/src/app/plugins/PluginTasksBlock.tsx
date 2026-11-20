import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { PLUGIN_PAGE_BUDGET, type PluginDescriptor, type Task, type TaskState } from '@contracts';
import { IconChevronRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/controls';
import { relativeTime } from '@/lib/i18n/format';
import { localizedText } from '@/lib/plugins';
import { tasksApi } from '@/lib/tasks';
import { cn, errorMessage } from '@/lib/utils';
import { SettingsGroup } from '../settings/SettingsLayout';
import { useLists } from '../state/stores';

/** Tasks fetched per plugin: the rows shown plus enough to say how many more there are. */

/** Whether the plugin declares a task provider, which is when its details show 最近任务 (docs/design/system/plugins.md §6.3). */
export function hasTasksBlock(plugin: PluginDescriptor): boolean {
  return (plugin.declared?.tasks?.length ?? 0) > 0;
}

/** The last reading per plugin, shown first while the next one is read. Bounded by the installed plugins. */
// perf-rules: allow one entry per installed plugin, 20 tasks each, kept for the page session
const cache = new Map<string, Task[]>();

const TONE: Record<TaskState, 'success' | 'danger' | 'accent' | 'idle'> = {
  succeeded: 'success', failed: 'danger', running: 'accent', cancelling: 'accent', cancelled: 'idle', unknown: 'idle',
};

/**
 * 最近任务 on a plugin's details: its task providers' most recent runs across projects (plugins.md §6.3). A row opens the task.
 */
export function PluginTasksBlock({ plugin, onOpenTask }: {
  plugin: PluginDescriptor;
  onOpenTask: (task: Task) => void;
}) {
  const { t } = useLingui();
  const pluginId = plugin.id;
  const projects = useLists((state) => state.projects);
  const [tasks, setTasks] = useState<Task[] | undefined>(() => cache.get(pluginId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setTasks(cache.get(pluginId));
    setLoading(true);
    setError(undefined);
    tasksApi.listByPlugin(pluginId, PLUGIN_PAGE_BUDGET.summaryRows, controller.signal).then(
      (list) => { if (controller.signal.aborted) return; cache.set(pluginId, list); setTasks(list); setLoading(false); },
      (reason) => { if (controller.signal.aborted) return; setError(errorMessage(reason)); setLoading(false); },
    );
    return () => controller.abort();
  }, [pluginId, tick]);

  const retry = useCallback(() => setTick((value) => value + 1), []);
  const stateLabel: Record<TaskState, string> = {
    running: t`运行中`, cancelling: t`正在取消`, succeeded: t`成功`, failed: t`失败`, cancelled: t`已取消`, unknown: t`状态未知`,
  };
  const projectName = (id: string): string => projects.find((item) => item.id === id)?.name ?? '—';
  const shown = (tasks ?? []).slice(0, PLUGIN_PAGE_BUDGET.summaryRows);

  return (
    <SettingsGroup title={t({ message: '最近任务', context: 'plugin-tasks-section' })} loading={tasks === undefined && !error}>
      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 py-4">
          <span className="min-w-0 break-words text-sm text-danger">{error}</span>
          <Button type="button" size="xs" variant="secondary" disabled={loading} onClick={retry}><Trans>重试</Trans></Button>
        </div>
      )}
      {tasks !== undefined && tasks.length === 0 && !error && (
        <p className="py-6 text-center text-sm text-fg-3"><Trans>还没有运行过任务</Trans></p>
      )}
      {shown.length > 0 && (
        <div className={cn('flex flex-col transition-opacity duration-[var(--duration-fast)] [&>*+*]:edge-t', loading && 'opacity-60')}>
          {shown.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => onOpenTask(task)}
              className="-mx-4 flex min-h-12 items-center gap-3 px-4 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus max-md:-mx-3 max-md:min-h-11 max-md:px-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{projectName(task.projectId)}</span>
                <span className="block truncate text-xs text-fg-3">{localizedText(task.title) ?? task.actionId}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-sm tabular-nums text-fg-3">
                <StatusDot tone={TONE[task.state]} pulse={task.state === 'running'} />
                {task.state === 'unknown' ? stateLabel.unknown : `${stateLabel[task.state]} · ${relativeTime(task.endedAt ?? task.startedAt) || '—'}`}
              </span>
              <IconChevronRight className="size-4 shrink-0 text-fg-4" />
            </button>
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}
