import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppSettings } from '@contracts';
import { IconArrowLeft, IconChevronRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { SearchField } from '@/components/ui/search-field';
import type { ProjectRecord } from '@/lib/api';
import { useDiscardGuard } from '@/lib/dialogs';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { cn, errorMessage } from '@/lib/utils';
import { cancelSettingsTransition, runSettingsTransition, SETTINGS_LIST_LEVEL, viewTransitionsSupported } from '@/lib/view-transition';
import { PageScaffold } from '../PageScaffold';
import { shortcutsSuspended } from '../shortcuts';
import { useNav, useStores } from '../state/stores';
import type { ProviderSettingsTarget } from '../state/uiStore';

import { ProfileSection } from './ProfileSection';
import { VoiceInputSection } from './VoiceInputSection';
import { AboutSection, AppIconSection, ConnectionSection, FilesSettingsSection, GeneralSection, InteractionSection, NotificationsSection, ReclaimSection, TerminalSettingsSection, ThemeSection, TypographySection } from './PreferencesSections';
import { BackupSection, DiagnosticsSection } from './SupportSections';
import { SharesSection } from '../shares/SharesSection';
import { ChannelsSection } from './ChannelsSection';
import { DevicesSection } from './DevicesSection';
import { LinksSection } from './LinksSection';
import { TabsSection } from './TabsSection';
import { ShortcutSettings } from './ShortcutSettings';
import { ViewsSection } from './ViewsSection';
import { SidebarSection } from './SidebarSection';
import { DEFAULT_SETTINGS_SECTION, filterSettingsNavigation, settingsGroupTitle, settingsSections, type SettingsSection, type SettingsSectionGroup } from './settingsSections';

export type { SettingsSection } from './settingsSections';

// The heavier sections load when first opened: the service charts share the statistics chunk.
const AgentSettingsSection = lazy(() => import('./AgentSettingsSection').then((module) => ({ default: module.AgentSettingsSection })));
const BackendProfilesSection = lazy(() => import('./BackendProfilesSection').then((module) => ({ default: module.BackendProfilesSection })));
const AuxiliaryModelsSection = lazy(() => import('./AuxiliaryModelsSection').then((module) => ({ default: module.AuxiliaryModelsSection })));
const WorkItemSettingsSection = lazy(() => import('./WorkItemSettingsSection').then((module) => ({ default: module.WorkItemSettingsSection })));
const AssistantSettingsSection = lazy(() => import('./AssistantSettingsSection').then((module) => ({ default: module.AssistantSettingsSection })));
const QuickChatSection = lazy(() => import('./QuickChatSection').then((module) => ({ default: module.QuickChatSection })));
const TitleRulesSection = lazy(() => import('./TitleRulesSection').then((module) => ({ default: module.TitleRulesSection })));
const ServiceStatusSection = lazy(() => import('./ServiceStatusSection').then((module) => ({ default: module.ServiceStatusSection })));
const StorageSection = lazy(() => import('./StorageSection').then((module) => ({ default: module.StorageSection })));
const DesignPage = lazy(() => import('../design/DesignPage').then((module) => ({ default: module.DesignPage })));
const sectionFallback = <div className="flex justify-center py-10"><Spinner /></div>;

interface Props {
  project?: ProjectRecord;
  settings: AppSettings;
  desktop: boolean;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onOpenSidebar: () => void;
  onClose: () => void;
  onSelectSection: (section: SettingsSection) => Promise<void>;
  onRefreshBackends: () => Promise<void>;
  onSettingsChanged: (settings: AppSettings, patch: Partial<AppSettings>) => void;
  onLogout?: () => void;
  onError: (message: string) => void;
  providerTarget?: ProviderSettingsTarget;
  onProviderTargetHandled?: (token: number) => void;
}

/**
 * Full-page settings surface: desktop uses `PageScaffold` with the main sidebar swapped to
 * `SettingsSidebar`; phones use two-level drill-down (category list -> section page).
 */
export function SettingsPage({
  project,
  settings,
  desktop,
  sidebarCollapsed,
  onExpandSidebar,
  onOpenSidebar,
  onClose,
  onSelectSection,
  onRefreshBackends,
  onSettingsChanged,
  onLogout,
  onError,
  providerTarget,
  onProviderTargetHandled,
}: Props) {
  const { t } = useLingui();
  const { nav } = useStores();
  const section = useNav((state) => state.settingsSection);
  const mobileDetail = useNav((state) => state.settingsMobileDetail);
  const sectionVisit = useNav((state) => state.settingsVisit);
  const [sectionBusy, setSectionBusy] = useState(false);
  const [backendsDirty, setBackendsDirty] = useState(false);
  const [filesDirty, setFilesDirty] = useState(false);
  const [mobileQuery, setMobileQuery] = useState('');
  const navigationPending = useRef(false);
  const navigationGeneration = useRef(0);

  useLayoutEffect(() => {
    navigationPending.current = false;
    return () => {
      navigationGeneration.current += 1;
      cancelSettingsTransition();
    };
  }, []);

  /**
   * Guards moving between sections, closing Settings, and closing the tab. Only the active
   * section reports dirty (each clears its flag as it unmounts).
   */
  const { confirm: confirmLeave } = useDiscardGuard(backendsDirty || filesDirty, sectionBusy);
  const clearDirty = useCallback(() => { setBackendsDirty(false); setFilesDirty(false); }, []);

  useEffect(() => {
    nav.registerSettingsBeforeLeave(async () => {
      if (!(await confirmLeave())) return false;
      clearDirty();
      return true;
    });
    return () => nav.registerSettingsBeforeLeave(undefined);
  }, [nav, confirmLeave, clearDirty]);

  const known = settingsSections.some((item) => item.id === section);
  const current = settingsSections.find((item) => item.id === (known ? section : DEFAULT_SETTINGS_SECTION))!;
  useEffect(() => { if (!known) nav.setSettingsSection(DEFAULT_SETTINGS_SECTION); }, [known, nav]);
  const parent = current.parent ? settingsSections.find((item) => item.id === current.parent) : undefined;
  const groupTitle = settingsGroupTitle(current.group);

  const openPluginPage = async (id: string) => {
    await nav.navigate(() => nav.openPlugins(id.split('/')[0], id));
  };
  /** A plugin's own page, where a recognizer's models are installed. */
  const openPluginDetails = async (id: string) => {
    await nav.navigate(() => nav.openPlugins(id, '', 'page'));
  };

  const selectMobileSection = async (next: SettingsSection) => {
    if (navigationPending.current) return;
    navigationPending.current = true;
    const generation = navigationGeneration.current;
    try {
      if (next !== section && !(await confirmLeave())) return;
      if (generation !== navigationGeneration.current) return;
      await runSettingsTransition({ from: mobileDetail ? section : SETTINGS_LIST_LEVEL, to: next, mobile: true }, () => {
        if (generation !== navigationGeneration.current) return;
        if (next !== section) clearDirty();
        nav.setSettingsSection(next, { mobileDetail: true });
      });
    } catch (error) { onError(errorMessage(error, t`无法切换设置分区`)); }
    finally { if (generation === navigationGeneration.current) navigationPending.current = false; }
  };

  const returnToMobileList = useCallback(async () => {
    if (current.parent) { await selectMobileSection(current.parent); return; }
    if (navigationPending.current) return;
    navigationPending.current = true;
    const generation = navigationGeneration.current;
    try {
      if (!(await confirmLeave())) return;
      if (generation !== navigationGeneration.current) return;
      clearDirty();
      await runSettingsTransition({ from: section, to: SETTINGS_LIST_LEVEL, mobile: true }, () => {
        if (generation !== navigationGeneration.current) return;
        nav.setSettingsSection(section, { mobileDetail: false, bumpVisit: true });
      });
    } catch (error) { onError(errorMessage(error, t`无法返回设置分区`)); }
    finally { if (generation === navigationGeneration.current) navigationPending.current = false; }
  }, [current.parent, section, confirmLeave, clearDirty, nav, onError, t]);

  const handleClose = useCallback(() => {
    if (shortcutsSuspended()) return;
    if (!desktop && mobileDetail && window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
      void returnToMobileList();
      return;
    }
    onClose();
  }, [desktop, mobileDetail, returnToMobileList, onClose]);

  const mobileGrouped = useMemo(() => {
    const matched = filterSettingsNavigation(mobileQuery);
    const groups = [...new Set(matched.map((item) => item.group))];
    return groups.map((group: SettingsSectionGroup) => ({
      group,
      title: settingsGroupTitle(group),
      items: matched.filter((item) => item.group === group),
    }));
  }, [mobileQuery]);

  const sectionEnter = viewTransitionsSupported() ? '' : 'animate-in fade-in-0 duration-[var(--duration-base)] ease-[var(--ease-decelerate)]';

  const body = (
    <div key={`${section}:${sectionVisit}`} className={sectionEnter}>
      {section === 'profile' && <ProfileSection onError={onError} />}
      {section === 'general' && <GeneralSection />}
      {section === 'appearance' && <ThemeSection />}
      {section === 'typography' && <TypographySection />}
      {section === 'sidebar' && <SidebarSection onError={onError} />}
      {section === 'tabs' && <TabsSection />}
      {section === 'shortcuts' && <ShortcutSettings />}
      {section === 'views' && <ViewsSection />}
      {section === 'terminal' && <TerminalSettingsSection settings={settings} onSaved={onSettingsChanged} onError={onError} />}
      {section === 'appicon' && <AppIconSection />}
      {section === 'notifications' && <NotificationsSection settings={settings} onSaved={onSettingsChanged} onError={onError} />}
      {section === 'backends' && <Suspense fallback={sectionFallback}><AgentSettingsSection settings={settings} onRefresh={onRefreshBackends} onDirtyChange={setBackendsDirty} onBusyChange={setSectionBusy} onOpenPage={(id) => void openPluginPage(id)} onError={onError} /></Suspense>}
      {section === 'providers' && <Suspense fallback={sectionFallback}><div className="flex flex-col gap-6">
        <BackendProfilesSection settings={settings} project={project} initialTarget={providerTarget} onTargetHandled={onProviderTargetHandled} onRefresh={onRefreshBackends} onDirtyChange={setBackendsDirty} onBusyChange={setSectionBusy} onOpenPage={(id) => void openPluginPage(id)} onError={onError} />
      </div></Suspense>}
      {section === 'auxiliary' && <Suspense fallback={sectionFallback}><AuxiliaryModelsSection settings={settings} onSaved={onSettingsChanged} onError={onError} onOpenTitleRules={() => void onSelectSection('titles')} /></Suspense>}
      {section === 'quickchat' && <Suspense fallback={sectionFallback}><QuickChatSection settings={settings} onSaved={onSettingsChanged} onError={onError} /></Suspense>}
      {section === 'assistant' && <Suspense fallback={sectionFallback}><AssistantSettingsSection /></Suspense>}
      {section === 'workitems' && <Suspense fallback={sectionFallback}><WorkItemSettingsSection /></Suspense>}
      {section === 'interaction' && <div className="flex flex-col gap-6">
        <InteractionSection settings={settings} onSaved={onSettingsChanged} onError={onError} />
        <VoiceInputSection settings={settings} onSaved={onSettingsChanged} onError={onError} onOpenPlugin={(id) => void openPluginDetails(id)} />
      </div>}
      {section === 'titles' && <Suspense fallback={sectionFallback}><TitleRulesSection settings={settings} onSaved={onSettingsChanged} onError={onError} /></Suspense>}
      {section === 'files' && <FilesSettingsSection settings={settings} onSaved={onSettingsChanged} onError={onError} onDirtyChange={setFilesDirty} onBusyChange={setSectionBusy} />}
      {section === 'connection' && <ConnectionSection onLogout={onLogout} onOpenShares={() => void onSelectSection('shares')} />}
      {section === 'shares' && <SharesSection />}
      {section === 'devices' && <DevicesSection settings={settings} onSaved={onSettingsChanged} />}
      {section === 'links' && <LinksSection />}
      {section === 'channels' && <ChannelsSection />}
      {section === 'service' && <div className="flex flex-col gap-6"><ReclaimSection settings={settings} onSaved={onSettingsChanged} onError={onError} /><Suspense fallback={sectionFallback}><ServiceStatusSection /></Suspense></div>}
      {section === 'storage' && <Suspense fallback={sectionFallback}><StorageSection /></Suspense>}
      {section === 'backup' && <BackupSection onError={onError} />}
      {section === 'diagnostics' && <DiagnosticsSection settings={settings} />}
      {section === 'about' && <AboutSection />}
    </div>
  );

  // Mobile: two-level full-screen drill-down (category list -> section detail) matching mobile.md §10.
  const designEmbedded = section === 'design' && (desktop || mobileDetail);
  const mobileOverlay = useOverlayState({ open: !desktop && !designEmbedded, onOpenChange: (next) => { if (!next) handleClose(); } });
  if (designEmbedded) {
    return (
      <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
        <DesignPage
          sidebarCollapsed={sidebarCollapsed}
          mobileBack={!desktop ? { label: t`返回设置分区`, onBack: () => void returnToMobileList() } : undefined}
          onClose={handleClose}
          onOpenSidebar={onOpenSidebar}
          onExpandSidebar={onExpandSidebar}
        />
      </Suspense>
    );
  }
  if (!desktop) {
    return (
      <OverlayScopeContext.Provider value={mobileOverlay.scope}>
        <div className="flex h-full min-h-0 flex-col bg-bg">
          {!mobileDetail ? (
            <div style={{ viewTransitionName: 'settings-list' }} className="flex min-h-0 flex-1 flex-col">
              <header className="flex h-12 shrink-0 items-center gap-2 px-1.5 edge-b">
                <Button size="icon-sm" variant="quiet" className="-mr-2 size-11" aria-label={t`返回`} onClick={onClose}><IconArrowLeft /></Button>
                <h1 className="min-w-0 truncate text-sm font-medium text-fg"><Trans>设置</Trans></h1>
              </header>
              <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-12 pt-4" aria-label={t`设置分区`}>
                <SearchField
                  value={mobileQuery}
                  onChange={setMobileQuery}
                  placeholder={t`搜索设置`}
                  aria-label={t`搜索设置`}
                />
                {mobileGrouped.length === 0 ? (
                  <p className="py-8 text-center text-sm text-fg-3"><Trans>没有匹配的设置</Trans></p>
                ) : (
                  mobileGrouped.map(({ group, title, items }) => (
                    <section key={group} className="flex flex-col gap-1">
                      {title && <h2 className="px-1 pb-1 text-xs font-medium text-fg-3">{title}</h2>}
                      <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-elevated [&>*+*]:edge-t">
                        {items.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => void selectMobileSection(item.id)}
                            className="flex min-h-12 items-center gap-3 px-3 text-left text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                          >
                            <item.icon className="size-4 shrink-0 text-fg-3" />
                            <span className="min-w-0 flex-1 text-sm">{item.label}</span>
                            <IconChevronRight className="size-4 shrink-0 text-fg-4" />
                          </button>
                        ))}
                      </div>
                    </section>
                  ))
                )}
              </nav>
            </div>
          ) : (
            <div style={{ viewTransitionName: 'settings-panel' }} className="flex min-h-0 flex-1 flex-col">
              <header className="flex h-12 shrink-0 items-center gap-2 px-1.5 edge-b">
                <Button size="icon-sm" variant="quiet" className="-mr-2 size-11" aria-label={parent ? t`返回${parent.label}` : t`返回设置分区`} onClick={() => void returnToMobileList()}><IconArrowLeft /></Button>
                <h1 className="min-w-0 truncate text-sm font-medium text-fg">{current.label}</h1>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-16 pt-6">
                {body}
              </div>
            </div>
          )}
        </div>
      </OverlayScopeContext.Provider>
    );
  }

  return (
    <PageScaffold
      title={
        parent ? (
          <span className="inline-flex items-center gap-1.5">
            <Button size="icon-xs" variant="quiet" aria-label={t`返回${parent.label}`} onClick={() => void onSelectSection(parent.id)}><IconArrowLeft /></Button>
            <span>{current.label}</span>
          </span>
        ) : current.label
      }
      meta={groupTitle ? <span className="truncate text-xs text-fg-4">{groupTitle}</span> : undefined}
      column="board"
      sidebarCollapsed={sidebarCollapsed}
      onClose={handleClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
    >
      <div style={{ viewTransitionName: 'settings-panel' }} className={cn('flex flex-col gap-6')}>
        {body}
      </div>
    </PageScaffold>
  );
}
