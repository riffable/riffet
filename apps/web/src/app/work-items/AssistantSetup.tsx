import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AssistantInstructions, AssistantMemory, AssistantMemoryEntry, NativeBackendId } from '@contracts';
import { IconBrain, IconChevronRight, IconShieldCheck, IconSparkles } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { EmptyState, Spinner, Textarea } from '@/components/ui/controls';
import { ListRow } from '@/components/ui/list-row';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useDiscardGuard } from '@/lib/dialogs';
import { timeAgo } from '@/lib/i18n/format';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { QuickAction } from '../QuickAction';
import { Markdown } from '../session/Markdown';
import { useStores } from '../state/stores';

export type AssistantSetupState = ReturnType<typeof useAssistantSetup>;

/** A memory file's own words: without the title and comment Riffet seeds it with, which the section heading already says. */
function written(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim().replace(/^# .*\n?/, '').trim();
}

/**
 * What the 个人助理 is made of: what it remembers (its directory's memory files), its rules (`AGENTS.md`)
 * and its abilities (the skills and MCP servers a launch there loads) (docs/ASSISTANT.md §3).
 * Shared by the page's cards and the main conversation's 会话信息, so both read and open the same
 * things. `enabled` false fetches nothing.
 */
export function useAssistantSetup({ projectId, backendId, profileId, enabled = true }: { projectId: string; backendId: NativeBackendId; profileId: string | undefined; enabled?: boolean }) {
  const { t } = useLingui();
  const { nav, ui } = useStores();
  const [instructions, setInstructions] = useState<AssistantInstructions>();
  const [editing, setEditing] = useState(false);
  const [abilities, setAbilities] = useState<number>();
  const [memory, setMemory] = useState<AssistantMemory>();
  const [memoryFailed, setMemoryFailed] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.assistantInstructions().then((value) => { if (live) setInstructions(value); }, () => undefined);
    return () => { live = false; };
  }, [enabled]);
  // Read again each time it is opened: the 助理 writes its memory while it works.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.assistantMemory().then((value) => { if (live) { setMemory(value); setMemoryFailed(false); } }, () => { if (live) setMemoryFailed(true); });
    return () => { live = false; };
  }, [enabled, memoryOpen]);
  const remembers = Boolean(memory && (memory.entries.length || written(memory.profile) || written(memory.index)));
  // Skills and MCP servers as a launch here loads them.
  useEffect(() => {
    if (!enabled) return;
    setAbilities(undefined);
    const controller = new AbortController();
    api.loadedExtensions(backendId, profileId, projectId, controller.signal)
      .then((loaded) => setAbilities(loaded.skills.length + loaded.mcp.length), () => undefined);
    return () => controller.abort();
  }, [enabled, backendId, profileId, projectId]);

  /** The rules were read when the page opened; a read that failed then is made again, and says so when it fails again. */
  const openRules = () => {
    if (instructions) { setEditing(true); return; }
    api.assistantInstructions().then((value) => { setInstructions(value); setEditing(true); }, (error: unknown) => toast.error(errorMessage(error)));
  };
  const openAbilities = () => {
    void nav.navigate(() => {
      ui.set({ extensionsFocus: { projectId, backendId, kind: 'skill', at: Date.now() } });
      nav.openPage('extensions');
    });
  };
  return {
    instructions,
    setInstructions,
    editing,
    setEditing,
    memory,
    memoryFailed,
    memoryOpen,
    setMemoryOpen,
    openAbilities,
    openRules,
    /** Each note is undefined until its count has loaded. */
    /** When it last wrote something down; nothing while it remembers nothing. */
    memoryNote: remembers && memory?.updatedAt ? timeAgo(memory.updatedAt) : undefined,
    instructionsNote: instructions ? instructions.custom ? t`已修改` : t`默认` : undefined,
    abilitiesNote: abilities === undefined ? undefined : t`${abilities} 项`,
  };
}

/** The dialogs the setup opens; render them outside any surface that closes on navigation. */
export function AssistantInstructions({ setup }: { setup: AssistantSetupState }) {
  return <>
    {setup.instructions && <InstructionsDialog open={setup.editing} value={setup.instructions} onClose={() => setup.setEditing(false)} onSaved={setup.setInstructions} />}
    <MemoryDialog open={setup.memoryOpen} memory={setup.memory} failed={setup.memoryFailed} onClose={() => setup.setMemoryOpen(false)} />
  </>;
}

/** The 个人助理 page's cards, under its composer. The agent and model are the composer's own pickers, which on this page save the 助理's choice. */
export function AssistantSetup(props: { projectId: string; backendId: NativeBackendId; profileId: string | undefined }) {
  const { t } = useLingui();
  const setup = useAssistantSetup(props);
  return (
    <div className="mt-4 grid gap-2 md:mt-8 sm:grid-cols-3">
      <QuickAction icon={<IconBrain />} title={t`记忆`} note={setup.memoryNote} onClick={() => setup.setMemoryOpen(true)} />
      <QuickAction icon={<IconShieldCheck />} title={t`规则`} note={setup.instructionsNote} onClick={setup.openRules} />
      <QuickAction icon={<IconSparkles />} title={t`能力`} note={setup.abilitiesNote} onClick={setup.openAbilities} />
      <AssistantInstructions setup={setup} />
    </div>
  );
}

function InstructionsDialog({ open, value, onClose, onSaved }: { open: boolean; value: AssistantInstructions; onClose: () => void; onSaved: (next: AssistantInstructions) => void }) {
  const { t } = useLingui();
  const [text, setText] = useState(value.text);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setText(value.text); }, [open, value.text]);
  const dirty = open && text !== value.text;
  const discard = useDiscardGuard(dirty, busy);
  const save = async (next: string | null) => {
    setBusy(true);
    try { onSaved(await api.saveAssistantInstructions(next)); onClose(); }
    catch (error) { toast.error(errorMessage(error, t`无法保存`)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) discard.close(onClose); }}>
      <DialogContent size="content" mobileFullscreen>
        <DialogHeader>
          <DialogTitle><Trans>规则</Trans></DialogTitle>
          <DialogDescription><Trans>保存为 AGENTS.md，下次启动时生效</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Textarea aria-label="AGENTS.md" value={text} rows={20} spellCheck={false} onChange={(event) => setText(event.target.value)} className="font-mono text-xs leading-relaxed" />
        </DialogBody>
        <DialogFooter>
          {value.custom && <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => void save(null)}><Trans>恢复默认</Trans></Button>}
          <Button variant="ghost" onClick={() => discard.close(onClose)}><Trans>取消</Trans></Button>
          <Button variant="primary" disabled={!dirty || busy} onClick={() => void save(text)}><Trans>保存</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A topic file's front matter names it and says what it holds; without one its first heading does, else the file name. */
function describe(entry: AssistantMemoryEntry): { title: string; note: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(entry.text);
  const field = (name: string) => match ? new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(match[1]!)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '' : '';
  const text = (match ? entry.text.slice(match[0].length) : entry.text).trim();
  // Its own first heading is its title too, and is not repeated under the row.
  const heading = /^# (.+)\n?/.exec(text);
  return { title: field('name') || heading?.[1]?.trim() || entry.name.replace(/\.md$/, ''), note: field('description'), body: heading ? text.slice(heading[0].length).trim() : text };
}

const memoryHeading = 'mb-1 px-2.5 text-xs font-medium text-fg-3';

/** What the 助理 remembers, read-only: its profile of the owner, then one row per thing it wrote down (docs/ASSISTANT.md §3.2). */
function MemoryDialog({ open, memory, failed, onClose }: { open: boolean; memory: AssistantMemory | undefined; failed: boolean; onClose: () => void }) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState<string>();
  useEffect(() => { if (!open) setExpanded(undefined); }, [open]);
  const profile = useMemo(() => written(memory?.profile ?? ''), [memory?.profile]);
  const entries = useMemo(() => (memory?.entries ?? []).map((entry) => ({ entry, ...describe(entry) })), [memory?.entries]);
  // With no topic files yet, what it remembers is the lines of its index.
  const index = useMemo(() => entries.length ? '' : written(memory?.index ?? ''), [entries.length, memory?.index]);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="content" mobileFullscreen>
        <DialogHeader>
          <DialogTitle><Trans>记忆</Trans></DialogTitle>
          <DialogDescription><Trans>只读。要增删或更正，直接告诉个人助理</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody className="min-h-48 pt-2">
          {!memory ? failed ? <EmptyState icon={<IconBrain />} title={t`无法读取记忆`} /> : <div className="grid min-h-48 place-items-center"><Spinner /></div>
            : !profile && !entries.length && !index ? <EmptyState icon={<IconBrain />} title={t`还没有记忆`} />
            : <div className="flex flex-col gap-6">
              {profile && <section>
                <h3 className={memoryHeading}><Trans>关于你</Trans></h3>
                <div className="px-2.5"><Markdown text={profile} /></div>
              </section>}
              {(entries.length > 0 || index) && <section>
                <h3 className={memoryHeading}><Trans>记下的事</Trans></h3>
                {index && <div className="px-2.5"><Markdown text={index} /></div>}
                <div className="flex flex-col">
                  {entries.map(({ entry, title, note, body }) => {
                    const shown = expanded === entry.name;
                    return (
                      <div key={entry.name}>
                        <ListRow
                          aria-expanded={shown}
                          leading={<IconChevronRight className={shown ? 'rotate-90 transition-transform duration-[var(--duration-fast)]' : 'transition-transform duration-[var(--duration-fast)]'} />}
                          meta={timeAgo(entry.modifiedAt)}
                          onClick={() => setExpanded(shown ? undefined : entry.name)}
                        >
                          {title}{note && <span className="ml-2 text-fg-3">{note}</span>}
                        </ListRow>
                        <Collapse open={shown}><div className="px-2.5 pb-3 pl-9 pt-1"><Markdown text={body} /></div></Collapse>
                      </div>
                    );
                  })}
                </div>
              </section>}
            </div>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
