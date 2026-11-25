import type { RefObject } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowLeft, IconAtSign, IconChevronRight, IconFileText, IconFolder, IconSlash } from '@/components/icons';
import type { FileEntry, Session } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { Spinner } from '@/components/ui/controls';
import { isSessionReference, type ProjectRecord, type PromptContextReference } from '@/lib/api';
import { backendLabel, sessionBackend } from '@/lib/backends';
import { cn } from '@/lib/utils';
import { MemberAvatar } from '../team/MemberAvatar';
import type { SlashCommand } from './model';
import type { AgentMentionCandidate } from './agentMentions';
import type { Trigger } from './useComposerTrigger';

export function ComposerTriggerMenu({
  trigger,
  fullscreen,
  isMobile,
  hero,
  browsing,
  browsingName,
  sessionMentions,
  showSearching,
  searching,
  menuListRef,
  menuId,
  optionId,
  slashGroups,
  slashItems,
  slashQuery,
  unknownSlashCommand,
  unknownCommandHint,
  highlight,
  setHighlight,
  choose,
  browseInto,
  files,
  agentRows,
  sessionFiles,
  projectRows,
  references,
  referenceSessions,
}: {
  trigger: Trigger;
  fullscreen: boolean;
  isMobile: boolean;
  hero: boolean;
  browsing?: string;
  browsingName: string;
  sessionMentions: boolean;
  showSearching: boolean;
  searching: boolean;
  menuListRef: RefObject<HTMLDivElement | null>;
  menuId: string;
  optionId: (index: number) => string;
  slashGroups: { kind: 'command' | 'skill'; items: SlashCommand[] }[];
  slashItems: SlashCommand[];
  slashQuery: string;
  unknownSlashCommand: boolean;
  unknownCommandHint?: string;
  highlight: number;
  setHighlight: (index: number) => void;
  choose: (index: number) => void;
  browseInto: (projectId: string | undefined) => void;
  files: FileEntry[];
  agentRows: AgentMentionCandidate[];
  sessionFiles: { session: Session; project: string; score: number }[];
  projectRows: ProjectRecord[];
  references: PromptContextReference[];
  referenceSessions?: Session[];
}) {
  const { t } = useLingui();
  const memberRows = agentRows.filter(item => Boolean(item.member));
  const backendRows = agentRows.filter(item => !item.member);
  return (
    <div className={cn('inset-x-0 z-(--z-dock) overflow-hidden rounded-xl bg-popover shadow-pop animate-in fade-in-0 duration-[var(--duration-fast)] ease-[var(--ease-decelerate)]', fullscreen ? 'absolute bottom-14 mx-3 mb-2' : isMobile ? 'relative mb-2' : hero ? 'absolute top-full mt-2 slide-in-from-top-1' : 'absolute bottom-full mb-2 slide-in-from-bottom-1')}>
      <div className="flex h-8 items-center gap-1.5 edge-b px-3 text-xs text-fg-3">
        {trigger.type === 'slash'
          ? <><IconSlash className="size-3" />{slashGroups.length > 1 ? t`命令与 Skills` : slashGroups[0]?.kind === 'skill' ? t`Skills` : t({ message: '命令', context: 'session-commands-label' })}</>
          : browsing
            ? <button type="button" tabIndex={-1} aria-label={t`返回`} onMouseDown={event => { event.preventDefault(); browseInto(undefined); }} className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-hover hover:text-fg-2"><IconArrowLeft className="size-3 shrink-0" /><span className="truncate">{browsingName}</span></button>
            : <><IconAtSign className="size-3" />{sessionMentions ? t`引用` : t`引用文件`}{showSearching && <Spinner className="ml-auto size-3" />}</>}
      </div>
      {/* File results arrive per keystroke in varying counts, so their list keeps one height
          from the moment `@` opens it; the phone's menu is in the flow above the card. */}
      <div ref={menuListRef} id={menuId} className={cn('overflow-y-auto overscroll-contain p-1', trigger.type === 'mention' ? 'h-64 max-md:h-[min(144px,calc(var(--app-height,100dvh)*0.28))]' : 'max-h-64 max-md:max-h-[min(144px,calc(var(--app-height,100dvh)*0.28))]')} role="listbox" aria-label={trigger.type === 'slash' ? t({ message: '命令', context: 'session-commands-label' }) : sessionMentions ? t`引用` : t`引用文件`}>
        {trigger.type === 'slash' && slashGroups.map((group, groupIndex) => {
          const offset = slashGroups.slice(0, groupIndex).reduce((total, previous) => total + previous.items.length, 0);
          return (
            <div key={group.kind} role="group" aria-label={group.kind === 'skill' ? t`Skills` : t({ message: '命令', context: 'session-commands-label' })}>
              {slashGroups.length > 1 && <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4">{group.kind === 'skill' ? t`Skills` : t({ message: '命令', context: 'session-commands-label' })}</div>}
              {group.items.map((command, itemIndex) => {
                const index = offset + itemIndex;
                return (
                  <button key={command.name} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} title={command.description} onPointerMove={() => setHighlight(index)} onMouseDown={(event) => { event.preventDefault(); choose(index); }} className={cn('flex min-h-11 w-full items-center gap-3 md:min-h-8 rounded-lg px-2 py-1.5 text-left text-sm', index === highlight && 'bg-hover')}>
                    <span className="max-w-[60%] shrink-0 truncate font-mono text-fg">/{command.name}</span>
                    <span className="min-w-0 truncate text-xs text-fg-3">{command.description ?? command.hint}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {trigger.type === 'slash' && unknownSlashCommand && (
          <button id={optionId(slashItems.length)} type="button" tabIndex={-1} role="option" aria-selected={highlight === slashItems.length} onPointerMove={() => setHighlight(slashItems.length)} onMouseDown={(event) => { event.preventDefault(); choose(slashItems.length); }} className={cn('flex min-h-11 w-full items-center gap-3 md:min-h-8 rounded-lg px-2 py-1.5 text-left text-sm', highlight === slashItems.length && 'bg-hover')}>
            <span className="shrink-0 font-mono text-fg">/{slashQuery}</span>
            <span className="min-w-0 truncate text-xs text-fg-3">{unknownCommandHint ?? t`将作为普通消息原样发送`}</span>
          </button>
        )}
        {trigger.type === 'mention' && files.length > 0 && sessionMentions && <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4"><Trans>文件</Trans></div>}
        {trigger.type === 'mention' && files.map((file, index) => (
          <button key={file.path} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} onPointerMove={() => setHighlight(index)} onMouseDown={(event) => { event.preventDefault(); choose(index); }} className={cn('flex h-11 w-full items-center gap-2 md:h-8 rounded-lg px-2 text-left text-sm', index === highlight && 'bg-hover')}>
            <IconFileText className="size-3.5 shrink-0 text-fg-3" />
            <span className="max-w-[50%] shrink-0 truncate text-fg">{file.name}</span>
            <span className="min-w-0 truncate font-mono text-2xs text-fg-3">{file.path}</span>
          </button>
        ))}
        {trigger.type === 'mention' && memberRows.length > 0 && <div role="group" aria-label={t`团队成员`}>
          <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4"><Trans>团队成员</Trans></div>
          {memberRows.map((item, itemIndex) => {
            const index = files.length + itemIndex;
            const member = item.member!;
            return <button key={`member:${member.id}`} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} onPointerMove={() => setHighlight(index)} onMouseDown={event => { event.preventDefault(); choose(index); }} className={cn('flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm md:h-8', index === highlight && 'bg-hover')}>
              <MemberAvatar member={member} size={18} className="shrink-0" />
              <span className="shrink-0 truncate text-fg">{item.label}</span>
              {member.description && <span className="min-w-0 flex-1 truncate text-2xs text-fg-3">{member.description}</span>}
            </button>;
          })}
        </div>}
        {trigger.type === 'mention' && backendRows.length > 0 && <div role="group" aria-label="Agent">
          <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4">Agent</div>
          {backendRows.map((item, itemIndex) => {
            const index = files.length + memberRows.length + itemIndex;
            return <button key={item.backendId} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} onPointerMove={() => setHighlight(index)} onMouseDown={event => { event.preventDefault(); choose(index); }} className={cn('flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm md:h-8', index === highlight && 'bg-hover')}>
              <AgentLogo backend={item.backendId} size={14} className="shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1 truncate text-fg">{item.label}</span>
            </button>;
          })}
        </div>}
        {trigger.type === 'mention' && sessionFiles.length > 0 && <div role="group" aria-label={t`会话`}>
          <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4"><Trans>会话</Trans></div>
          {sessionFiles.map(({ session: item, project }, itemIndex) => {
            const index = files.length + agentRows.length + itemIndex;
            const selected = references.some(reference => isSessionReference(reference) && reference.sessionId === item.id);
            const blocked = !selected && references.filter(isSessionReference).length >= 5;
            return <button key={item.id} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} disabled={blocked} onPointerMove={() => setHighlight(index)} onMouseDown={event => { event.preventDefault(); choose(index); }} className={cn('flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm disabled:opacity-50 md:h-8', index === highlight && 'bg-hover')}>
              <AgentLogo backend={sessionBackend(item)} size={14} className="shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1 truncate text-fg">{item.title}</span>
              <span className="max-w-[45%] truncate text-2xs text-fg-3">{[browsing ? '' : project, backendLabel(sessionBackend(item)), item.archivedAt ? t`已归档` : '', referenceSessions?.some(other => other.id !== item.id && other.title === item.title) ? item.id.slice(0, 8) : ''].filter(Boolean).join(' · ')}</span>
            </button>;
          })}
        </div>}
        {trigger.type === 'mention' && projectRows.length > 0 && <div role="group" aria-label={t({ message: '项目', context: 'mention-projects' })}>
          <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4">{t({ message: '项目', context: 'mention-projects' })}</div>
          {projectRows.map((item, itemIndex) => {
            const index = files.length + agentRows.length + sessionFiles.length + itemIndex;
            return <button key={item.id} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} title={item.cwd} onPointerMove={() => setHighlight(index)} onMouseDown={event => { event.preventDefault(); choose(index); }} className={cn('flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm md:h-8', index === highlight && 'bg-hover')}>
              <IconFolder className="size-3.5 shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1 truncate text-fg">{item.name}</span>
              <IconChevronRight className="size-3.5 shrink-0 text-fg-3" />
            </button>;
          })}
        </div>}
        {trigger.type === 'mention' && !files.length && !agentRows.length && !sessionFiles.length && !projectRows.length && trigger.query && <div className="px-2 py-3 text-sm text-fg-3">{searching ? t`搜索中…` : browsing ? t`没有匹配的会话` : sessionMentions ? t`没有匹配的会话或文件` : t`没有匹配的文件`}</div>}
      </div>
    </div>
  );
}
