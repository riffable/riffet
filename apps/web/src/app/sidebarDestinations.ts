import type { ComponentType } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { DEFAULT_SIDEBAR_PINNED, SIDEBAR_DESTINATIONS, type SidebarDestination } from '@contracts';
import { IconBookmark, IconBot, IconCalendarClock, IconChartColumn, IconMessagesSquare, IconPuzzle, IconSquareKanban, IconWrench } from '@/components/icons';

/** The sidebar's destinations the web has; 活动 is the Mac's. */
export type WebSidebarDestination = Exclude<SidebarDestination, 'activity'>;

export const SIDEBAR_DESTINATION_META: Record<WebSidebarDestination, { label: MessageDescriptor; icon: ComponentType<{ className?: string }> }> = {
  assistant: { label: msg`个人助理`, icon: IconBot },
  tasks: { label: msg`任务看板`, icon: IconSquareKanban },
  automations: { label: msg`自动化`, icon: IconCalendarClock },
  council: { label: msg`模型协作`, icon: IconMessagesSquare },
  marks: { label: msg`收藏夹`, icon: IconBookmark },
  plugins: { label: msg`插件`, icon: IconPuzzle },
  extensions: { label: msg`扩展管理`, icon: IconWrench },
  stats: { label: msg`数据统计`, icon: IconChartColumn },
};

export const WEB_SIDEBAR_DESTINATIONS = SIDEBAR_DESTINATIONS.filter((id): id is WebSidebarDestination => id in SIDEBAR_DESTINATION_META);

/** What `AppSettings.sidebarPinned` holds, or the default while it is unset. */
export function savedSidebarPinned(saved: readonly string[] | undefined): readonly string[] {
  return saved ?? DEFAULT_SIDEBAR_PINNED;
}

/** The offered destinations as sidebar rows, in the saved order, and the 更多 menu, in the catalog's. */
export function splitSidebarDestinations<T extends string>(saved: readonly string[] | undefined, offered: readonly T[]): { pinned: T[]; more: T[] } {
  const pinned = savedSidebarPinned(saved).filter((id): id is T => offered.includes(id as T));
  return { pinned, more: offered.filter((id) => !pinned.includes(id)) };
}

/** [saved] with [id] pinned last or unpinned; ids this client does not offer keep their places. */
export function toggleSidebarPinned(saved: readonly string[] | undefined, id: string, pinned: boolean): string[] {
  const current = savedSidebarPinned(saved).filter((item) => item !== id);
  return pinned ? [...current, id] : current;
}

/** [saved] with its rows in [ordered]'s order, slot by slot; ids this client does not offer keep their places. */
export function reorderSidebarPinned(saved: readonly string[] | undefined, ordered: readonly string[]): string[] {
  const rows = new Set(ordered);
  const queue = [...ordered];
  return savedSidebarPinned(saved).map((id) => rows.has(id) ? queue.shift()! : id);
}
