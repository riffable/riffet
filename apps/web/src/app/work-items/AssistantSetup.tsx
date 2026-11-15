import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AssistantInstructions, ExtensionKind, NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import { IconLayers, IconServer, IconShieldCheck, IconSparkles } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useDiscardGuard } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { QuickAction } from '../QuickAction';
import { useStores } from '../state/stores';

type Counted = Extract<ExtensionKind, 'skill' | 'mcp' | 'plugin'>;

/** Extensions belong to the agent's own configuration, read through its local profile as the extensions page does. */
function extensionProfile(backend: NativeBackendCatalogEntry | undefined): string | undefined {
  return (backend?.profiles.find((profile) => profile.id === 'local') ?? backend?.profiles.find((profile) => profile.isDefault) ?? backend?.profiles[0])?.id;
}

/**
 * What the 助理 works with, under its composer: its instructions (`AGENTS.md`) and the skills, MCP
 * servers and plugins its agent loads in its directory. Each opens where it is edited. The agent and
 * model are the composer's own pickers, which on this page save the 助理's choice.
 */
export function AssistantSetup({ projectId, backendId, profileId, backends }: { projectId: string; backendId: NativeBackendId; profileId: string | undefined; backends: NativeBackendCatalogEntry[] }) {
  const { t } = useLingui();
  const { nav, ui } = useStores();
  const [instructions, setInstructions] = useState<AssistantInstructions>();
  const [editing, setEditing] = useState(false);
  const [counts, setCounts] = useState<Partial<Record<Counted, number>>>({});
  const extensionProfileId = extensionProfile(backends.find((entry) => entry.backendId === backendId));

  useEffect(() => {
    let live = true;
    api.assistantInstructions().then((value) => { if (live) setInstructions(value); }, () => undefined);
    return () => { live = false; };
  }, []);
  // Skills and MCP servers as a launch here loads them; plugins as the agent has them switched on.
  useEffect(() => {
    setCounts({});
    const controller = new AbortController();
    api.loadedExtensions(backendId, profileId, projectId, controller.signal)
      .then((loaded) => setCounts((current) => ({ ...current, skill: loaded.skills.length, mcp: loaded.mcp.length })), () => undefined);
    if (extensionProfileId) {
      api.extensions({ backendId, profileId: extensionProfileId, projectId }, controller.signal)
        .then((inventory) => setCounts((current) => ({ ...current, plugin: inventory.items.filter((item) => item.kind === 'plugin' && item.enabled === true).length })), () => undefined);
    }
    return () => controller.abort();
  }, [backendId, profileId, extensionProfileId, projectId]);

  const openExtensions = (kind: Counted) => {
    void nav.navigate(() => {
      ui.set({ extensionsFocus: { projectId, backendId, kind, at: Date.now() } });
      nav.openPage('extensions');
    });
  };
  const count = (kind: Counted) => counts[kind] === undefined ? undefined : t`${counts[kind]} 个`;

  return (
    <div className="mt-4 grid grid-cols-2 gap-2 md:mt-8 sm:grid-cols-4">
      <QuickAction icon={<IconShieldCheck />} title="AGENTS.md" note={instructions ? instructions.custom ? t`已修改` : t`默认` : undefined} onClick={() => setEditing(true)} />
      <QuickAction icon={<IconSparkles />} title="Skills" note={count('skill')} onClick={() => openExtensions('skill')} />
      <QuickAction icon={<IconServer />} title="MCP" note={count('mcp')} onClick={() => openExtensions('mcp')} />
      <QuickAction icon={<IconLayers />} title={t`插件`} note={count('plugin')} onClick={() => openExtensions('plugin')} />
      {instructions && <InstructionsDialog open={editing} value={instructions} onClose={() => setEditing(false)} onSaved={setInstructions} />}
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
          <DialogTitle>AGENTS.md</DialogTitle>
          <DialogDescription><Trans>新对话生效</Trans></DialogDescription>
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
