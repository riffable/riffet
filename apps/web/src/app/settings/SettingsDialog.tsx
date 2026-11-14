import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowLeft, IconChevronRight } from '@/components/icons';
import type { AppSettings } from '@contracts';
import { Button } from '@/components/ui/button';
import { ListRow } from '@/components/ui/list-row';
import { Spinner } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { ProjectRecord } from '@/lib/api';
import { useDiscardGuard } from '@/lib/dialogs';
import { cn, errorMessage } from '@/lib/utils';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { cancelSettingsTransition, runSettingsTransition, SETTINGS_LIST_LEVEL, viewTransitionsSupported } from '@/lib/view-transition';
import { useStores } from '../state/stores';
import { SettingsGroup as Group, SettingsLinkRow } from './SettingsLayout';

import { ProfileSection } from './ProfileSection';
import { AboutSection, AppIconSection, ConnectionSection, FilesSettingsSection, GeneralSection, InteractionSection, NotificationsSection, ReclaimSection, TerminalSettingsSection, ThemeSection, TypographySection } from './PreferencesSections';
import { BackupSection, DiagnosticsSection } from './SupportSections';
import { SharesSection } from '../shares/SharesSection';
import { ChannelsSection } from './ChannelsSection';
import { DevicesSection } from './DevicesSection';
import { TabsSection } from './TabsSection';
import { ViewsSection } from './ViewsSection';
import { SETTINGS_DIALOG_CLASS, settingsGroupTitle, settingsNavigationSections, settingsSections, type SettingsSection, type SettingsSectionGroup } from './settingsSections';
export type { SettingsSection } from './settingsSections';
type Section = SettingsSection;
// The heavier sections load when first opened: the service charts share the statistics chunk.
const BackendProfilesSection = lazy(() => import('./BackendProfilesSection').then((module) => ({ default: module.BackendProfilesSection })));
const AuxiliaryModelsSection = lazy(() => import('./AuxiliaryModelsSection').then((module) => ({ default: module.AuxiliaryModelsSection })));
const QuickChatSection = lazy(() => import('./QuickChatSection').then((module) => ({ default: module.QuickChatSection })));
const ServiceStatusSection = lazy(() => import('./ServiceStatusSection').then((module) => ({ default: module.ServiceStatusSection })));
const sectionFallback = <div className="flex justify-center py-10"><Spinner /></div>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: ProjectRecord;
  settings: AppSettings;
  onRefreshBackends: () => Promise<void>;
  onSettingsChanged: (settings: AppSettings, patch: Partial<AppSettings>) => void;
  onLogout?: () => void;
  onError: (message: string) => void;
  /** Its loading frame already played the entrance in this place, so the dialog opens without another; closing still animates. */
  framed?: boolean;
  /**
   * The section to land on when the dialog opens, for a caller that already knows where the reader
   * is going (the command palette). It only decides where the dialog opens; navigation inside it
   * still belongs to the dialog.
   */
  initialSection?: SettingsSection;
}

export function SettingsDialog({ open, onOpenChange, project, settings, onRefreshBackends, onSettingsChanged, onLogout, onError, initialSection, framed }: Props) {
  const { t } = useLingui();
  // The section labels resolve the active locale when they are read, so each render reads them anew.
  const sections = settingsSections;
  const { nav } = useStores();
  const [section, setSection] = useState<Section>('general');
  const [mobileSectionOpen, setMobileSectionOpen] = useState(false);
  const [sectionVisit, setSectionVisit] = useState(0);
  const [sectionBusy, setSectionBusy] = useState(false);
  const [backendsDirty, setBackendsDirty] = useState(false);
  const [filesDirty, setFilesDirty] = useState(false);
  const navigationPending = useRef(false);
  const navigationGeneration = useRef(0);
  const wasOpen = useRef(false);
  const previousInitialSection = useRef(initialSection);
  useLayoutEffect(() => {
    navigationPending.current = false;
    return () => {
      navigationGeneration.current += 1;
      cancelSettingsTransition();
    };
  }, [open]);
  /**
   * Guards moving around inside the dialog, closing it, and closing the tab. Only the open section
   * reports dirty (each clears its flag as it unmounts), so any flag is the current section's.
   */
  const { confirm: confirmLeave } = useDiscardGuard(open && (backendsDirty || filesDirty), open && sectionBusy);
  const known = sections.some((item) => item.id === section);
  const current = sections.find((item) => item.id === (known ? section : 'backends'))!;
  useEffect(() => { if (!known) setSection('backends'); }, [known]);
  const parent = current.parent ? sections.find((item) => item.id === current.parent) : undefined;
  const navigationGroups = [...new Set(settingsNavigationSections.map((item) => item.group))];
  const navigationItems = (group: SettingsSectionGroup) => settingsNavigationSections.filter((item) => item.group === group);
  const selected = (id: Section) => section === id || current.parent === id;
  const openPluginPage = async (id: string) => {
    if (!await confirmLeave()) return;
    onOpenChange(false);
    await nav.navigate(() => nav.openPlugins(id.split('/')[0], id));
  };
  const openDesign = async () => {
    if (!await confirmLeave()) return;
    onOpenChange(false);
    await nav.navigate(() => nav.openPage('design'));
  };
  const clearDirty = () => { setBackendsDirty(false); setFilesDirty(false); };
  const selectSection = async (next: Section) => {
    if (next === 'design') { await openDesign(); return; }
    if (navigationPending.current) return;
    navigationPending.current = true;
    const generation = navigationGeneration.current;
    try {
      if (next !== section && !(await confirmLeave())) return;
      if (generation !== navigationGeneration.current) return;
      const mobile = window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
      await runSettingsTransition({ from: mobile && !mobileSectionOpen ? SETTINGS_LIST_LEVEL : section, to: next, mobile }, () => {
        if (generation !== navigationGeneration.current) return;
        if (next !== section) clearDirty();
        setSection(next);
        setMobileSectionOpen(true);
      });
    } catch (error) { onError(errorMessage(error, t`无法切换设置分区`)); }
    finally { if (generation === navigationGeneration.current) navigationPending.current = false; }
  };
  useLayoutEffect(() => {
    const opening = open && !wasOpen.current;
    const sectionChanged = initialSection !== previousInitialSection.current;
    wasOpen.current = open;
    previousInitialSection.current = initialSection;
    if (!open) return;
    if (!opening) {
      if (sectionChanged && initialSection) void selectSection(initialSection);
      return;
    }
    // Keep the current page intact while the dialog leaves. Opening starts a fresh visit,
    // without capturing the dialog's own entrance in an internal View Transition.
    setSection(initialSection ?? 'general');
    setMobileSectionOpen(Boolean(initialSection));
    setSectionVisit((visit) => visit + 1);
    clearDirty();
  }, [open, initialSection]);
  const returnToList = async () => {
    if (current.parent) { await selectSection(current.parent); return; }
    if (navigationPending.current) return;
    navigationPending.current = true;
    const generation = navigationGeneration.current;
    try {
      if (!(await confirmLeave())) return;
      if (generation !== navigationGeneration.current) return;
      clearDirty();
      await runSettingsTransition({ from: section, to: SETTINGS_LIST_LEVEL, mobile: true }, () => {
        if (generation !== navigationGeneration.current) return;
        setMobileSectionOpen(false);
        // The panel remains mounted for desktop resizing; a discarded mobile draft must not return.
        setSectionVisit((visit) => visit + 1);
      });
    } catch (error) { onError(errorMessage(error, t`无法返回设置分区`)); }
    finally { if (generation === navigationGeneration.current) navigationPending.current = false; }
  };
  const changeOpen = async (next: boolean) => {
    if (navigationPending.current) return;
    navigationPending.current = true;
    const generation = navigationGeneration.current;
    try {
      if (!next && !(await confirmLeave())) return;
      if (generation !== navigationGeneration.current) return;
      onOpenChange(next);
    } finally { if (generation === navigationGeneration.current) navigationPending.current = false; }
  };
  const canGoBack = () => mobileSectionOpen && window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
  const goBack = () => { void (canGoBack() ? returnToList() : changeOpen(false)); };
  // A View Transition owns the section change where it exists, so the CSS enter animation would
  // only fight the snapshot. Without the API this is exactly the fade the dialog has always had.
  const sectionEnter = viewTransitionsSupported() ? '' : 'animate-in fade-in-0 duration-[var(--duration-base)] ease-[var(--ease-decelerate)]';
  return (
    <Dialog open={open} onOpenChange={(next) => void changeOpen(next)} onBack={goBack}>
      {/* During a section's View Transition the pseudo-element tree covers the page and a click
          resolves to <html>, which Radix reads as outside the dialog. A real outside click lands on
          the overlay, never on <html>, so only that target is ignored. */}
      <DialogContent size="workspace" mobileFullscreen onEscapeKeyDown={(event) => { if (canGoBack()) { event.preventDefault(); goBack(); } }} onInteractOutside={(event) => { if (event.target === document.documentElement) event.preventDefault(); }} overlayClassName={cn(framed && open && 'animate-none!')} className={cn(SETTINGS_DIALOG_CLASS, 'md:flex-row', framed && open && 'animate-none!')}>
        <DialogTitle className="sr-only"><Trans>设置</Trans></DialogTitle>
        <nav aria-label={t`设置分区`} className="hidden w-52 shrink-0 flex-col gap-px overflow-y-auto edge-r bg-sidebar p-2 md:flex">
          <h2 className="px-2.5 pb-3 pt-2 text-base font-semibold"><Trans>设置</Trans></h2>
          {navigationGroups.map((group) => <div key={group} className="mb-3 flex flex-col gap-px">
            {settingsGroupTitle(group) && <h3 className="px-2.5 pb-1 pt-2 text-2xs font-medium text-fg-4">{settingsGroupTitle(group)}</h3>}
            {navigationItems(group).map((item) => (
              <ListRow key={item.id} aria-current={selected(item.id) ? 'page' : undefined} selected={selected(item.id)} onClick={() => void selectSection(item.id)} leading={<item.icon />}>
                {item.label}
              </ListRow>
            ))}
          </div>)}
        </nav>
        {!mobileSectionOpen && <nav style={{ viewTransitionName: 'settings-list' }} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:hidden" aria-label={t`设置分区`}>
          <h2 className="px-1 text-lg font-semibold"><Trans>设置</Trans></h2>
          {navigationGroups.map((group) => <section key={group} className="flex flex-col gap-1">
            {settingsGroupTitle(group) && <h3 className="px-1 pb-1 text-xs font-medium text-fg-3">{settingsGroupTitle(group)}</h3>}
            <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-elevated [&>*+*]:edge-t">
              {navigationItems(group).map((item) => (
                <button key={item.id} type="button" onClick={() => void selectSection(item.id)} className="flex min-h-12 items-center gap-3 px-3 text-left text-fg hover:bg-hover">
                  <item.icon className="size-4 shrink-0 text-fg-3" />
                  <span className="min-w-0 flex-1 text-sm">{item.label}</span>
                  <IconChevronRight className="size-4 shrink-0 text-fg-4" />
                </button>
              ))}
            </div>
          </section>)}
        </nav>}
        <div style={{ viewTransitionName: 'settings-panel' }} className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !mobileSectionOpen && 'max-md:hidden')}>
          <div className="flex h-14 shrink-0 items-center gap-2 px-6 pr-14 edge-b md:px-6">
            <div className="flex min-w-0 items-center gap-2 md:hidden">
              <Button size="icon-xs" variant="quiet" className="size-9" aria-label={t`返回设置分区`} onClick={() => void returnToList()}><IconArrowLeft /></Button>
              <h2 className="truncate text-base font-semibold">{current.label}</h2>
            </div>
            {parent && <Button size="icon-xs" variant="quiet" className="hidden md:inline-flex" aria-label={t`返回${parent.label}`} onClick={() => void selectSection(parent.id)}><IconArrowLeft /></Button>}
            <h2 className="hidden text-lg font-semibold text-fg md:block">{current.label}</h2>
          </div>
          <div key={`${section}:${sectionVisit}`} className={cn('min-h-0 flex-1 px-6 py-5 max-md:px-4', sectionEnter, 'overflow-y-auto')}>
            {section === 'profile' && <ProfileSection onError={onError} />}
            {section === 'general' && <GeneralSection />}
            {section === 'appearance' && <ThemeSection />}
            {section === 'typography' && <TypographySection />}
            {section === 'tabs' && <TabsSection />}
            {section === 'views' && <ViewsSection />}
            {section === 'terminal' && <TerminalSettingsSection />}
            {section === 'appicon' && <AppIconSection />}
            {section === 'notifications' && <NotificationsSection settings={settings} onSaved={onSettingsChanged} onError={onError} />}
            {section === 'backends' && <Suspense fallback={sectionFallback}><div className="flex flex-col gap-6">
              <BackendProfilesSection settings={settings} project={project} onSaved={onSettingsChanged} onRefresh={onRefreshBackends} onDirtyChange={setBackendsDirty} onBusyChange={setSectionBusy} onOpenPage={(id) => void openPluginPage(id)} onError={onError} />
            </div></Suspense>}
            {section === 'auxiliary' && <Suspense fallback={sectionFallback}><AuxiliaryModelsSection settings={settings} onSaved={onSettingsChanged} onError={onError} /></Suspense>}
            {section === 'quickchat' && <Suspense fallback={sectionFallback}><QuickChatSection settings={settings} onSaved={onSettingsChanged} onError={onError} /></Suspense>}
            {section === 'interaction' && <InteractionSection settings={settings} onSaved={onSettingsChanged} onError={onError} />}
            {section === 'files' && <FilesSettingsSection settings={settings} onSaved={onSettingsChanged} onError={onError} onDirtyChange={setFilesDirty} onBusyChange={setSectionBusy} />}
            {section === 'connection' && <ConnectionSection onLogout={onLogout} onOpenShares={() => void selectSection('shares')} />}
            {section === 'shares' && <SharesSection />}
            {section === 'devices' && <DevicesSection />}
            {section === 'channels' && <ChannelsSection />}
            {section === 'service' && <><ReclaimSection settings={settings} onSaved={onSettingsChanged} onError={onError} /><Suspense fallback={sectionFallback}><ServiceStatusSection /></Suspense></>}
            {section === 'backup' && <BackupSection onError={onError} />}
            {section === 'diagnostics' && <DiagnosticsSection settings={settings} />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
