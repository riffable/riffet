import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  DEFAULT_AGENT_MEMBER_ID,
  TEAM_BUDGET,
  isAssistantBackend,
  memberChoice,
  type AgentMember,
  type AgentMemberCapabilities,
  type AgentMemberScope,
  type AgentMemberScopeKind,
  type AgentMemberSessionMode,
} from '@contracts';
import { IconChevronDown, IconFileText, IconSettings2, IconShieldCheck, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { fieldClass, Input, Segmented, Select, Spinner, Switch, Textarea, UnderlineTabs } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { ListRow } from '@/components/ui/list-row';
import { api, type ProjectRecord } from '@/lib/api';
import { confirmDialog, useDiscardGuard } from '@/lib/dialogs';
import { regularProjects } from '@/lib/project-family';
import { toast } from '@/lib/toast';
import { cn, errorMessage } from '@/lib/utils';
import { useAgentModelChoice, type AgentModelValue } from '../session/agentModelChoice';
import { ModelPicker } from '../session/ModelPicker';
import { SettingsGroup, SettingsRow } from '../settings/SettingsLayout';
import { useCatalog } from '../state/stores';
import { avatarDraftFromMember, avatarInputFromDraft, MemberAvatar, MemberAvatarControls, type MemberAvatarDraft } from './MemberAvatar';

type Tab = 'general' | 'rules' | 'capabilities';

interface Props {
  open: boolean;
  member: AgentMember | undefined;
  projects: ProjectRecord[];
  onClose: () => void;
  onUpdated: (member: AgentMember) => void;
  onDeleted: (memberId: string) => void;
}

/**
 * Workspace-sized configuration dialog for a team member (docs/TEAM.md §7.3, patterns.md §1.4 & §2.2):
 * fixed desktop height with a `bg-sidebar` left nav rail (`w-56`) and `SettingsGroup` / `SettingsRow` content.
 */
export function MemberConfigDialog({ open, member, projects, onClose, onUpdated, onDeleted }: Props) {
  const { t } = useLingui();
  const backends = useCatalog((state) => state.backends);
  const isolatedBackends = useMemo(() => backends.filter((entry) => isAssistantBackend(entry.backendId)), [backends]);
  const codeProjects = useMemo(() => regularProjects(projects).filter((item) => !item.archivedAt), [projects]);

  const [tab, setTab] = useState<Tab>('general');
  const [avatar, setAvatar] = useState<MemberAvatarDraft>({ kind: 'none' });
  const [avatarBaseline, setAvatarBaseline] = useState<MemberAvatarDraft>({ kind: 'none' });
  const [name, setName] = useState('');
  const [target, setTarget] = useState<AgentModelValue | undefined>();
  const [targetBaseline, setTargetBaseline] = useState<AgentModelValue | undefined>();
  const [scopeKind, setScopeKind] = useState<AgentMemberScopeKind>('personal');
  const [projectId, setProjectId] = useState('');
  const [sessionMode, setSessionMode] = useState<AgentMemberSessionMode>('continuous');
  const [dailyRuns, setDailyRuns] = useState('30');
  const [capabilities, setCapabilities] = useState<AgentMemberCapabilities>({
    workspace: true, taskBoard: true, delegations: true, memberCalls: true, externalTools: true, workbenchAdmin: false,
  });

  const [instructionsText, setInstructionsText] = useState('');
  const [instructionsBaseline, setInstructionsBaseline] = useState('');
  const [instructionsCustom, setInstructionsCustom] = useState(false);
  const [userProfileText, setUserProfileText] = useState('');
  const [userProfileBaseline, setUserProfileBaseline] = useState('');
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !member) return;
    setTab('general');
    const initialAvatar = avatarDraftFromMember(member.avatar);
    setAvatar(initialAvatar);
    setAvatarBaseline(initialAvatar);
    setName(member.name);
    const initialTarget = memberChoice(member.target, isolatedBackends);
    setTarget(initialTarget);
    setTargetBaseline(initialTarget);
    setScopeKind(member.scope.kind);
    setProjectId(member.scope.kind === 'project' ? (member.scope.projectIds?.[0] ?? member.projectId) : (codeProjects[0]?.id ?? ''));
    setSessionMode(member.sessionMode);
    setDailyRuns(String(member.budget.dailyRuns));
    setCapabilities(member.capabilities);

    let live = true;
    setLoadingDocs(true);
    Promise.all([
      api.teamMemberInstructions(member.id),
      api.teamUserProfile(),
    ]).then(([inst, profile]) => {
      if (!live) return;
      setInstructionsText(inst.text);
      setInstructionsBaseline(inst.text);
      setInstructionsCustom(inst.custom);
      setUserProfileText(profile.text);
      setUserProfileBaseline(profile.text);
    }, (caught) => {
      if (live) toast.error(errorMessage(caught, t`无法读取成员规则`));
    }).finally(() => {
      if (live) setLoadingDocs(false);
    });
    return () => { live = false; };
  }, [open, member?.id]);

  useEffect(() => {
    if (!open || !member || target || !isolatedBackends.length) return;
    const resolved = memberChoice(member.target, isolatedBackends);
    setTarget(resolved);
    setTargetBaseline(resolved);
  }, [open, member, target, isolatedBackends]);

  const effectiveProjectId = scopeKind === 'project' && projectId ? projectId : (member?.projectId ?? '');
  const { picker, pick, params, withParam } = useAgentModelChoice({
    projectId: effectiveProjectId,
    backends: isolatedBackends,
    choice: target,
    agents: true,
  });

  const parsedRuns = Number(dailyRuns);
  const isDefault = member?.id === DEFAULT_AGENT_MEMBER_ID;
  const avatarDirty = JSON.stringify(avatar) !== JSON.stringify(avatarBaseline);
  const targetDirty = JSON.stringify(target ?? null) !== JSON.stringify(targetBaseline ?? null);
  const metaDirty = Boolean(member && (
    avatarDirty
    || targetDirty
    || name.trim() !== member.name
    || scopeKind !== member.scope.kind
    || (scopeKind === 'project' && member.scope.kind === 'project' && projectId !== (member.scope.projectIds?.[0] ?? member.projectId))
    || sessionMode !== member.sessionMode
    || (Number.isFinite(parsedRuns) && Math.round(parsedRuns) !== member.budget.dailyRuns)
    || JSON.stringify(capabilities) !== JSON.stringify(member.capabilities)
  ));
  const instructionsDirty = instructionsText !== instructionsBaseline;
  const profileDirty = userProfileText !== userProfileBaseline;
  const dirty = open && (metaDirty || instructionsDirty || profileDirty);
  const discard = useDiscardGuard(dirty, busy);

  const tabOptions = useMemo(() => [
    { value: 'general' as const, label: t({ message: '基础', context: 'team-member-tab' }), icon: <IconSettings2 /> },
    { value: 'rules' as const, label: t`规则与画像`, icon: <IconFileText /> },
    { value: 'capabilities' as const, label: t`能力权限`, icon: <IconShieldCheck /> },
  ], [t]);

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

  const capabilityItems: Array<{ key: keyof AgentMemberCapabilities; label: string; hint: string; lockedForDefault?: boolean }> = useMemo(() => [
    { key: 'workspace', label: t`读写代码目录`, hint: t`绑定代码项目时生效` },
    { key: 'taskBoard', label: t`操作任务看板`, hint: t`创建和更新任务状态`, lockedForDefault: true },
    { key: 'delegations', label: t`自动值守与提醒`, hint: t`创建定时唤醒、委托与通知`, lockedForDefault: true },
    { key: 'memberCalls', label: t`调用其他成员`, hint: t`向团队内其他成员发起协作调用`, lockedForDefault: true },
    { key: 'externalTools', label: t`设备与外部工具`, hint: t`使用已配对设备与外部能力` },
    { key: 'workbenchAdmin', label: t`工作台管理`, hint: t`读取状态与修改外观设置`, lockedForDefault: true },
  ], [t]);

  if (!member) return null;

  const displayName = name.trim() || member.name;
  const boundProjectName = codeProjects.find((item) => item.id === projectId)?.name;
  const scopeSummary = scopeKind === 'project'
    ? (boundProjectName ?? t`绑定项目`)
    : scopeKind === 'global' ? t`跨项目通用` : t`个人事务`;
  const activeTabLabel = tabOptions.find((item) => item.value === tab)?.label ?? '';

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error(t`请填写成员名称`); return; }
    if (scopeKind === 'project' && !projectId) { toast.error(t`请选择绑定的代码项目`); return; }
    setBusy(true);
    try {
      let latest = member;
      if (metaDirty) {
        const scope: AgentMemberScope = scopeKind === 'project'
          ? { kind: 'project', projectIds: [projectId] }
          : { kind: scopeKind };
        const avatarInput = avatarDirty ? avatarInputFromDraft(avatar) : undefined;
        const updated = await api.updateTeamMember(member.id, {
          name: trimmed,
          ...(avatarInput !== undefined ? { avatar: avatarInput } : {}),
          ...(targetDirty && target ? {
            target: {
              backendId: target.backendId,
              ...(target.profileId ? { profileId: target.profileId } : {}),
              ...(target.model ? { model: target.model } : {}),
              ...(member.target?.permissionMode ? { permissionMode: member.target.permissionMode } : {}),
            },
          } : {}),
          ...(!isDefault ? { scope } : {}),
          sessionMode,
          capabilities,
          ...(Number.isFinite(parsedRuns) ? { budget: { dailyRuns: Math.round(parsedRuns) } } : {}),
        });
        latest = updated;
        onUpdated(updated);
      }
      if (instructionsDirty) {
        const saved = await api.saveTeamMemberInstructions(member.id, instructionsText);
        setInstructionsBaseline(saved.text);
        setInstructionsCustom(saved.custom);
      }
      if (profileDirty) {
        const saved = await api.saveTeamUserProfile(userProfileText);
        setUserProfileBaseline(saved.text);
        setUserProfileText(saved.text);
      }
      toast.success(t`已保存「${latest.name}」`);
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught, t`无法保存`));
    } finally {
      setBusy(false);
    }
  };

  const resetInstructions = async () => {
    setBusy(true);
    try {
      const saved = await api.saveTeamMemberInstructions(member.id, null);
      setInstructionsText(saved.text);
      setInstructionsBaseline(saved.text);
      setInstructionsCustom(saved.custom);
      toast.success(t`已恢复默认规则`);
    } catch (caught) {
      toast.error(errorMessage(caught, t`无法恢复默认`));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: t`删除「${member.name}」？`,
      description: t`成员目录与历史会话保留在磁盘上，不再出现在团队列表中。`,
      confirmLabel: t`删除成员`,
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteTeamMember(member.id);
      toast.success(t`已删除「${member.name}」`);
      onDeleted(member.id);
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught, t`无法删除成员`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) discard.close(onClose); }}>
      <DialogContent
        size="workspace"
        mobileFullscreen
        aria-describedby={undefined}
        className="overflow-hidden md:h-[min(680px,calc(100dvh-64px))]"
      >
        <DialogTitle className="sr-only">{displayName}</DialogTitle>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Desktop left rail: follows patterns.md §1.4 aside spec (w-56, bg-sidebar, edge-r). */}
          <aside className="hidden w-56 shrink-0 flex-col bg-sidebar edge-r md:flex">
            <div className="flex items-center gap-3 px-4 pb-4 pt-5">
              <MemberAvatar draft={avatar} name={displayName} isDefault={isDefault} size={36} className="ring-1 ring-line" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-fg">{displayName}</p>
                <p className="truncate text-2xs text-fg-3">{scopeSummary}</p>
              </div>
            </div>
            <nav aria-label={t`成员设置分类`} className="flex flex-col gap-0.5 px-2.5">
              {tabOptions.map((item) => (
                <ListRow
                  key={item.value}
                  selected={tab === item.value}
                  aria-current={tab === item.value ? 'page' : undefined}
                  leading={item.icon}
                  onClick={() => setTab(item.value)}
                >
                  {item.label}
                </ListRow>
              ))}
            </nav>
          </aside>

          {/* Mobile header with properly sized UnderlineTabs bar. */}
          <div className="shrink-0 md:hidden">
            <div className="flex items-center gap-3 px-5 pb-3 pt-5 pr-12">
              <MemberAvatar draft={avatar} name={displayName} isDefault={isDefault} size={28} className="ring-1 ring-line" />
              <span className="min-w-0 truncate text-lg font-semibold text-fg">{displayName}</span>
            </div>
            <div className="flex h-11 items-stretch edge-b px-5">
              <UnderlineTabs
                value={tab}
                options={tabOptions.map(({ value, label }) => ({ value, label }))}
                onChange={setTab}
                ariaLabel={t`成员设置分类`}
              />
            </div>
          </div>

          {/* Right content column with fixed section header, scrollable body, and anchored footer. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="hidden shrink-0 items-center px-7 pb-4 pt-6 pr-14 md:flex">
              <h2 className="text-base font-semibold text-fg">{activeTabLabel}</h2>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 md:px-7 md:pb-6 md:pt-1">
              {tab === 'general' && (
                <div className="flex flex-col gap-6">
                  <SettingsGroup>
                    <div className="py-4">
                      <MemberAvatarControls value={avatar} name={name} isDefault={isDefault} disabled={busy} onChange={setAvatar} />
                    </div>
                    <SettingsRow title={t`名称`}>
                      <Input
                        value={name}
                        maxLength={64}
                        onChange={(event) => setName(event.target.value)}
                        className="w-64 max-md:w-full"
                      />
                    </SettingsRow>
                  </SettingsGroup>

                  <SettingsGroup title={t`运行设置`}>
                    <SettingsRow title={t`Agent 与模型`}>
                      <span className="relative flex w-64 min-w-0 max-md:w-full">
                        <ModelPicker
                          side="bottom"
                          align="end"
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
                    </SettingsRow>

                    {!isDefault && (
                      <SettingsRow title={t`作用范围`}>
                        <Segmented
                          value={scopeKind}
                          options={scopeOptions}
                          ariaLabel={t`作用范围`}
                          onChange={(next) => {
                            setScopeKind(next);
                            if (next === 'project' && !projectId && codeProjects[0]) setProjectId(codeProjects[0].id);
                          }}
                        />
                      </SettingsRow>
                    )}

                    {!isDefault && scopeKind === 'project' && (
                      <SettingsRow title={t`绑定项目`}>
                        <Select
                          label={t`绑定项目`}
                          value={projectId}
                          options={projectOptions}
                          onChange={setProjectId}
                          className="w-64 max-md:w-full"
                        />
                      </SettingsRow>
                    )}

                    <SettingsRow
                      title={t`对话模式`}
                      description={sessionMode === 'continuous'
                        ? t`一条主对话，/new 换话题`
                        : t`每次新开对话，靠记忆复用`}
                    >
                      <Segmented value={sessionMode} options={modeOptions} ariaLabel={t`对话模式`} onChange={setSessionMode} />
                    </SettingsRow>

                    <SettingsRow title={t`每日运行上限`} description={t`1–${TEAM_BUDGET.maxDailyRuns} 次`}>
                      <Input
                        type="number"
                        min={1}
                        max={TEAM_BUDGET.maxDailyRuns}
                        value={dailyRuns}
                        onChange={(event) => setDailyRuns(event.target.value)}
                        className="w-28 max-md:w-full"
                      />
                    </SettingsRow>
                  </SettingsGroup>

                  {!isDefault && (
                    <SettingsGroup>
                      <SettingsRow
                        title={<span className="text-danger"><Trans>删除成员</Trans></span>}
                        description={t`移除团队入口，保留磁盘目录`}
                      >
                        <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>
                          <IconTrash2 />
                          <Trans>删除</Trans>
                        </Button>
                      </SettingsRow>
                    </SettingsGroup>
                  )}
                </div>
              )}

              {tab === 'rules' && (
                loadingDocs ? (
                  <div className="grid h-full min-h-60 place-items-center"><Spinner /></div>
                ) : (
                  <div className="grid h-full min-h-0 gap-6 md:grid-cols-2">
                    <div className="flex min-h-0 min-w-0 flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-fg"><Trans>成员规则（AGENTS.md）</Trans></span>
                        {instructionsCustom && (
                          <Button variant="ghost" size="xs" disabled={busy} onClick={() => void resetInstructions()}>
                            <Trans>恢复默认</Trans>
                          </Button>
                        )}
                      </div>
                      <Textarea
                        value={instructionsText}
                        spellCheck={false}
                        onChange={(event) => setInstructionsText(event.target.value)}
                        className="min-h-64 flex-1 resize-none font-mono text-xs leading-relaxed"
                      />
                      <p className="text-xs text-fg-3"><Trans>下次启动生效</Trans></p>
                    </div>

                    <div className="flex min-h-0 min-w-0 flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-fg"><Trans>全局用户画像（USER.md）</Trans></span>
                        <span className="text-2xs tabular-nums text-fg-4">
                          {userProfileText.trim().length}/{TEAM_BUDGET.globalUserProfileChars}
                        </span>
                      </div>
                      <Textarea
                        value={userProfileText}
                        spellCheck={false}
                        onChange={(event) => setUserProfileText(event.target.value)}
                        className="min-h-64 flex-1 resize-none font-mono text-xs leading-relaxed"
                      />
                      <p className="text-xs text-fg-3">
                        <Trans>所有成员只读，最多 {TEAM_BUDGET.globalUserProfileChars} 字</Trans>
                      </p>
                    </div>
                  </div>
                )
              )}

              {tab === 'capabilities' && (
                <SettingsGroup>
                  {capabilityItems.map((item) => {
                    const locked = isDefault && Boolean(item.lockedForDefault);
                    return (
                      <SettingsRow key={item.key} title={item.label} description={item.hint}>
                        <Switch
                          checked={capabilities[item.key]}
                          disabled={locked}
                          onCheckedChange={(checked) => setCapabilities((prev) => ({ ...prev, [item.key]: checked }))}
                          aria-label={item.label}
                        />
                      </SettingsRow>
                    );
                  })}
                </SettingsGroup>
              )}
            </div>

            <DialogFooter className="edge-t px-5 py-4 md:px-7">
              <Button variant="ghost" onClick={() => discard.close(onClose)}><Trans>取消</Trans></Button>
              <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>
                <Trans>保存</Trans>
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
