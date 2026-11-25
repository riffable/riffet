import { useLingui } from '@lingui/react/macro';
import { DEFAULT_AGENT_MEMBER_ID } from '@contracts';
import { IconFolderPlus, IconSquareTerminal } from '@/components/icons';
import { api } from '@/lib/api';
import { promptDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { ResumeInTerminalDialog } from './ResumeInTerminalDialog';
import { Header, type HeaderSlots } from './Header';
import type { UiStore } from './state/uiStore';
import { useLists, useNav, useStores, useUi } from './state/stores';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { shownView, useSidebarViews } from './panels/useSidebarViews';
import { useDeletionLoading } from './SessionDeletion';

/**
 * The 变更 / 文件 toggle the header and the palette share: asking for the view already showing
 * closes the panel. `shown` is what the panel draws (`shownView`), which may not be the stored choice.
 */
export function togglePanelTab(ui: UiStore, tab: string, shown: string | undefined) {
  if (ui.get().panelOpen && shown === tab) { ui.setPanelOpen(false); return; }
  ui.set({ panelTab: tab });
  ui.setPanelOpen(true);
}

/**
 * The header of a conversation (or of the project home when `sessionId` is empty). It reads the
 * panel and dock state itself, so toggling them re-renders only this, not the page around it.
 * A stable component type: a parent that rebuilds its `renderHeader` callback does not remount it.
 */
export function WorkbenchHeader({ sessionId, slots, center }: { sessionId?: string; slots?: HeaderSlots; center?: ReactNode }) {
  const { t } = useLingui();
  const { ui, handlers, lists, nav } = useStores();
  const desktop = !useMediaQuery(MOBILE_LAYOUT_QUERY);
  const projectId = useNav((state) => state.projectId);
  const project = useLists((state) => state.projects.find((item) => item.id === projectId));
  const quickChat = project?.system === 'quick-chat';
  const originProject = useLists((state) => state.projects.find((item) => item.id === project?.worktree?.originProjectId));
  const session = useLists((state) => sessionId ? state.sessions.find((item) => item.id === sessionId) : undefined);
  // Resumed in a terminal it would start without the 助理's own prompt and isolation (docs/ASSISTANT.md §4).
  // None of the 个人助理's or team members' conversations is listed, tabbed or resumed outside its launch.
  const assistantOwned = project?.system === 'assistant' || Boolean(session?.agentMemberId);
  const deletable = useLists((state) => state.sessionDelete);
  const deleting = useDeletionLoading(sessionId ?? '');
  const sidebarCollapsed = useUi((state) => state.sidebarCollapsed);
  const panelOpen = useUi((state) => state.panelOpen);
  const panelTab = useUi((state) => state.panelTab);
  const sidebarViews = useSidebarViews(project, sessionId);
  const shownTab = shownView(sidebarViews, panelTab)?.id;
  const dockOpen = useUi((state) => state.dockOpen);
  const infoOpen = useUi((state) => state.sessionInfoOpen);
  const memberSessionsPref = useUi((state) => state.memberSessionsOpen);
  const selectedMemberId = useNav((state) => state.memberId);
  const teamMembers = useLists((state) => state.teamMembers);
  const sessions = useLists((state) => state.sessions);
  const activeMember = session?.agentMemberId
    ? teamMembers.find((item) => item.id === session.agentMemberId)
    : selectedMemberId
      ? teamMembers.find((item) => item.id === selectedMemberId)
      : project?.agentMemberId
        ? teamMembers.find((item) => item.id === project.agentMemberId)
        : project?.system === 'assistant'
          ? teamMembers.find((item) => item.id === DEFAULT_AGENT_MEMBER_ID)
          : undefined;
  const memberSessionCount = activeMember
    ? sessions.filter((item) => !item.archivedAt && (item.agentMemberId === activeMember.id || (activeMember.scope.kind !== 'project' && item.projectId === activeMember.projectId))).length
    : 0;
  const memberSessionsOpen = activeMember
    ? (desktop ? (memberSessionsPref ?? (activeMember.sessionMode === 'fresh' || memberSessionCount > 1)) : false)
    : false;
  // The popover describes one session; it does not follow the reader to the next, and closes before the next one paints.
  useLayoutEffect(() => { ui.set({ sessionInfoOpen: false }); }, [ui, sessionId]);
  const [resumeOpen, setResumeOpen] = useState(false);
  return (
    <>
    <Header
      center={center}
      project={quickChat ? undefined : project}
      originProject={quickChat ? undefined : originProject}
      quickChat={quickChat}
      session={session}
      sidebarCollapsed={desktop && sidebarCollapsed}
      onExpandSidebar={() => ui.setSidebarCollapsed(false)}
      onOpenMobileSidebar={() => ui.setMobileSidebar(true)}
      panelTab={panelOpen ? shownTab : undefined}
      panelOffered={project?.system !== 'assistant' || sidebarViews.length > 0}
      onTogglePanel={(tab) => togglePanelTab(ui, tab, shownTab)}
      terminalOpen={dockOpen}
      infoOpen={infoOpen}
      onInfoOpenChange={(open) => ui.set({ sessionInfoOpen: open })}
      onToggleTerminal={() => ui.setDockOpen((value) => !value)}
      onOpenMemberConfig={(memberId) => handlers.openMemberConfig(memberId)}
      {...(activeMember ? {
        memberSessionsToggle: {
          open: memberSessionsOpen,
          count: memberSessionCount,
          onToggle: () => {
            if (desktop) ui.set({ memberSessionsOpen: !memberSessionsOpen });
            else ui.set({ mobileMemberSessions: true });
          },
        },
      } : {})}
      {...(session ? {
        // A name, tags and a pin place a conversation in the lists; the 助理's is a page, in none of them.
        ...(assistantOwned ? {} : {
          onRename: () => handlers.sessionAction(session, 'rename'),
          onEditTags: () => handlers.sessionAction(session, 'tags'),
          onTogglePin: () => handlers.sessionAction(session, 'pin'),
        }),
        onToggleArchive: () => handlers.sessionAction(session, 'archive'),
        ...(deletable ? { onDelete: () => handlers.sessionAction(session, 'delete'), deleteDisabled: deleting } : {}),
      } : {})}
      {...slots}
      menu={[
        ...(slots?.menu ?? []),
        ...(session && session.kind === 'native' && !session.archivedAt && !quickChat && !assistantOwned && session.nativeSessionId && !session.terminalHold ? [{ id: 'resume-in-terminal', icon: <IconSquareTerminal />, label: t`在终端恢复…`, onSelect: () => setResumeOpen(true) }] : []),
        ...(project?.system === 'task-workspace' && session ? [{
          id: 'promote-project', icon: <IconFolderPlus />, label: t`保存为项目`, onSelect: () => {
            void (async () => {
              const name = await promptDialog({ title: t`保存为项目`, initial: session.title, confirmLabel: t`保存` });
              if (!name?.trim()) return;
              try {
                const saved = await api.promoteProject(project.id, name.trim());
                lists.upsertProject(saved);
                nav.rememberTaskProject(saved.id);
              } catch (error) { toast.error(errorMessage(error, t`无法保存项目`)); }
            })();
          },
        }] : []),
      ]}
    />
    {session && <ResumeInTerminalDialog open={resumeOpen} onOpenChange={setResumeOpen} session={session} />}
    </>
  );
}
