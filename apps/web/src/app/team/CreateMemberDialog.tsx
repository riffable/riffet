import { useEffect, useId, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { isAssistantBackend, memberChoice, type AgentMember, type AgentMemberScope, type AgentMemberScopeKind, type AgentMemberSessionMode, type AgentMemberTarget } from '@contracts';
import { IconChevronDown } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Field, fieldClass, Input, Segmented, Select, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, type ProjectRecord } from '@/lib/api';
import { useDiscardGuard } from '@/lib/dialogs';
import { isAssistantProject, regularProjects } from '@/lib/project-family';
import { toast } from '@/lib/toast';
import { cn, errorMessage } from '@/lib/utils';
import { useAgentModelChoice, type AgentModelValue } from '../session/agentModelChoice';
import { ModelPicker } from '../session/ModelPicker';
import { useCatalog } from '../state/stores';
import { avatarInputFromDraft, MemberAvatarControls, type MemberAvatarDraft } from './MemberAvatar';

const fill = 'w-full [&>[role=radio]]:flex-1';

interface Props {
  open: boolean;
  projects: ProjectRecord[];
  onClose: () => void;
  onCreated: (member: AgentMember) => void;
}

/**
 * Creation dialog for a standing team member (docs/TEAM.md §7.2):
 * two-column workspace layout with identity + AGENTS.md on the left, runtime settings on the right.
 */
export function CreateMemberDialog({ open, projects, onClose, onCreated }: Props) {
  const { t } = useLingui();
  const instructionsId = useId();
  const backends = useCatalog((state) => state.backends);
  const isolatedBackends = useMemo(() => backends.filter((entry) => isAssistantBackend(entry.backendId)), [backends]);
  const codeProjects = useMemo(() => regularProjects(projects).filter((item) => !item.archivedAt), [projects]);
  const fallbackProjectId = useMemo(() => projects.find(isAssistantProject)?.id ?? codeProjects[0]?.id ?? '', [projects, codeProjects]);

  const [avatar, setAvatar] = useState<MemberAvatarDraft>({ kind: 'none' });
  const [name, setName] = useState('');
  const [target, setTarget] = useState<AgentModelValue | undefined>();
  const [instructions, setInstructions] = useState('');
  const [scopeKind, setScopeKind] = useState<AgentMemberScopeKind>('personal');
  const [projectId, setProjectId] = useState('');
  const [sessionMode, setSessionMode] = useState<AgentMemberSessionMode>('continuous');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAvatar({ kind: 'none' });
    setName('');
    setTarget(memberChoice(undefined, isolatedBackends));
    setInstructions('');
    setScopeKind('personal');
    setProjectId(codeProjects[0]?.id ?? '');
    setSessionMode('continuous');
    setError('');
  }, [open]);

  // Fill a default agent/model once the backend catalog finishes loading after the dialog opens.
  useEffect(() => {
    if (!open || target || !isolatedBackends.length) return;
    setTarget(memberChoice(undefined, isolatedBackends));
  }, [open, target, isolatedBackends]);

  const effectiveProjectId = scopeKind === 'project' && projectId ? projectId : fallbackProjectId;
  const { picker, pick, params, withParam } = useAgentModelChoice({
    projectId: effectiveProjectId,
    backends: isolatedBackends,
    choice: target,
    agents: true,
  });

  const dirty = open && (
    avatar.kind !== 'none'
    || name.trim() !== ''
    || instructions !== ''
  );
  const discard = useDiscardGuard(dirty, busy);

  const projectOptions = useMemo(() => codeProjects.map((item) => ({ value: item.id, label: item.name })), [codeProjects]);
  const scopeOptions: Array<{ value: AgentMemberScopeKind; label: string; disabled?: boolean }> = useMemo(() => [
    { value: 'personal', label: t`个人事务` },
    { value: 'project', label: t`绑定项目`, disabled: codeProjects.length === 0 },
    { value: 'global', label: t`跨项目通用` },
  ], [t, codeProjects.length]);
  const modeOptions: Array<{ value: AgentMemberSessionMode; label: string }> = useMemo(() => [
    { value: 'continuous', label: t`持续对话` },
    { value: 'fresh', label: t`每次新开` },
  ], [t]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError(t`请填写成员名称`); return; }
    if (scopeKind === 'project' && !projectId) { setError(t`请选择绑定的代码项目`); return; }
    setError('');
    setBusy(true);
    try {
      const scope: AgentMemberScope = scopeKind === 'project'
        ? { kind: 'project', projectIds: [projectId] }
        : { kind: scopeKind };
      const chosenTarget: AgentMemberTarget | undefined = target
        ? {
          backendId: target.backendId,
          ...(target.profileId ? { profileId: target.profileId } : {}),
          ...(target.model ? { model: target.model } : {}),
        }
        : undefined;
      const avatarInput = avatarInputFromDraft(avatar);
      const member = await api.createTeamMember({
        name: trimmed,
        ...(avatarInput ? { avatar: avatarInput } : {}),
        scope,
        sessionMode,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(chosenTarget ? { target: chosenTarget } : {}),
      });
      toast.success(t`已创建「${member.name}」`);
      onCreated(member);
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught, t`无法创建成员`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) discard.close(onClose); }}>
      <DialogContent size="workspace" mobileFullscreen aria-describedby={undefined} className="overflow-hidden md:h-[min(640px,calc(100dvh-64px))]">
        <DialogHeader className="px-6 pb-4 pt-6 md:px-7">
          <DialogTitle><Trans>新建成员</Trans></DialogTitle>
        </DialogHeader>
        <DialogBody className="grid flex-1 gap-x-8 gap-y-6 px-6 pb-6 md:grid-cols-[minmax(0,1fr)_20rem] md:px-7">
          <div className="flex min-w-0 flex-col gap-5">
            <MemberAvatarControls value={avatar} name={name} disabled={busy} onChange={setAvatar} />

            <Field label={t`名称`} error={error || undefined}>
              <Input
                value={name}
                maxLength={64}
                placeholder={t`例如：发版打包、Riffet 验收、理财分析`}
                onChange={(event) => { setName(event.target.value); if (error) setError(''); }}
                autoFocus
              />
            </Field>

            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor={instructionsId} className="text-sm font-medium text-fg"><Trans>职责与规则</Trans></label>
                <span className="font-mono text-xs text-fg-4">AGENTS.md</span>
              </div>
              <Textarea
                id={instructionsId}
                value={instructions}
                spellCheck={false}
                placeholder={t`职责、常用步骤、输出规范或边界…`}
                onChange={(event) => setInstructions(event.target.value)}
                className="min-h-60 flex-1 resize-none font-mono text-xs leading-relaxed md:min-h-80"
              />
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-5 max-md:edge-t max-md:pt-5 md:edge-l md:pl-8">
            <Field label={t`Agent 与模型`}>
              <span className="relative flex min-w-0">
                <ModelPicker
                  side="bottom"
                  align="start"
                  placeholder={t`默认模型`}
                  disabled={!isolatedBackends.length}
                  {...picker}
                  className={cn(fieldClass, 'h-9 w-full justify-start pr-8 text-fg hover:bg-elevated hover:text-fg data-[state=open]:border-accent data-[state=open]:bg-elevated data-[state=open]:text-fg data-[state=open]:ring-3 data-[state=open]:ring-accent/15 max-md:h-11 max-md:rounded-xl max-md:px-3 max-md:pr-8 max-md:text-base')}
                  labelClassName="min-w-0 flex-1 max-w-none truncate text-left sm:max-w-none"
                  params={params}
                  onParamChange={(id, value) => {
                    const updated = withParam(id, value);
                    if (updated) setTarget(updated);
                  }}
                  onChange={(id) => {
                    const picked = pick(id);
                    if (picked) setTarget(picked);
                  }}
                />
                <IconChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
              </span>
            </Field>

            <div className="flex flex-col gap-2.5 edge-t pt-5">
              <span className="text-sm font-medium text-fg"><Trans>作用范围</Trans></span>
              <Segmented className={fill} value={scopeKind} options={scopeOptions} ariaLabel={t`作用范围`} onChange={(next) => {
                setScopeKind(next);
                if (next === 'project' && !projectId && codeProjects[0]) setProjectId(codeProjects[0].id);
              }} />
              {scopeKind === 'project' && (
                <Select
                  label={t`绑定项目`}
                  value={projectId}
                  options={projectOptions}
                  onChange={setProjectId}
                  placeholder={t`选择项目`}
                />
              )}
            </div>

            <div className="flex flex-col gap-2 edge-t pt-5">
              <span className="text-sm font-medium text-fg"><Trans>对话模式</Trans></span>
              <Segmented className={fill} value={sessionMode} options={modeOptions} ariaLabel={t`对话模式`} onChange={setSessionMode} />
              <p className="text-xs text-fg-3">
                {sessionMode === 'continuous'
                  ? t`一条主对话，/new 换话题`
                  : t`每次新开对话，靠记忆复用`}
              </p>
            </div>
          </div>
        </DialogBody>
        <DialogFooter className="edge-t px-6 py-4 md:px-7">
          <Button variant="ghost" onClick={() => discard.close(onClose)}><Trans>取消</Trans></Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            <Trans>创建</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
