import { useLingui } from '@lingui/react/macro';
import { workItemAgentChoice, type NativeBackendId } from '@contracts';
import { AgentMark } from '@/components/agent-marks';
import { Select, Switch } from '@/components/ui/controls';
import { agentMarkStyle, backendLabel } from '@/lib/backends';
import { useAgentModelChoice } from '../session/agentModelChoice';
import { ModelPicker } from '../session/ModelPicker';
import { useCatalog, useSettings, useStores } from '../state/stores';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

/** What follows the composer: nothing is saved for the agent, so the new-conversation default applies. */
const FOLLOW = '';

/** 任务看板's settings (docs/TASK-BOARD.md §10): saved at once, on the server, for every device. */
export function WorkItemSettingsSection() {
  const { t } = useLingui();
  const { settings } = useStores();
  const saved = useSettings((value) => value.workItems);
  const defaultBackendId = useSettings((value) => value.defaultBackendId);
  const backends = useCatalog((state) => state.backends);
  const workers = backends.filter((entry) => entry.backendId !== 'chat' && entry.available);
  const choice = workItemAgentChoice({ workItems: saved, defaultBackendId }, backends);
  const pinned = Boolean(saved?.backendId) && choice?.backendId === saved?.backendId;
  const { picker, pick } = useAgentModelChoice({ projectId: '', backends, choice });
  const pickModel = (id: string) => {
    const picked = pick(id);
    if (picked) settings.rememberWorkItems({ backendId: picked.backendId, profileId: picked.profileId ?? null, model: picked.model ?? null });
  };
  return <div className="flex flex-col gap-6">
    <SettingsGroup>
      <SettingsRow title={t`新会话作为任务`} description={t`快速对话和个人助理除外`}>
        <Switch aria-label={t`新会话作为任务`} checked={saved?.composerSessions === true} onCheckedChange={(value) => settings.rememberWorkItems({ composerSessions: value })} />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup>
      <SettingsRow title={t`默认 Agent`}>
        <Select<NativeBackendId | typeof FOLLOW> label={t`默认 Agent`} className="w-48" value={pinned ? saved!.backendId! : FOLLOW}
          options={[{ value: FOLLOW, label: t`跟随新会话` }, ...workers.map((entry) => ({ value: entry.backendId, label: backendLabel(entry.backendId), icon: <AgentMark backend={entry.backendId} size={14} style={agentMarkStyle(entry.backendId)} /> }))]}
          onChange={(value) => settings.rememberWorkItems(value === FOLLOW ? { backendId: null, profileId: null, model: null } : { backendId: value, profileId: null, model: null })} />
      </SettingsRow>
      <SettingsRow title={t`默认模型`}>
        <ModelPicker side="bottom" align="end" className="h-8 rounded-lg border border-line-strong bg-elevated px-3 text-fg-2 max-md:min-w-0 max-md:flex-1" placeholder={t`默认模型`} disabled={!pinned} {...picker} onChange={pickModel} />
      </SettingsRow>
    </SettingsGroup>
  </div>;
}
