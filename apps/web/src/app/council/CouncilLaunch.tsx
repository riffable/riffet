import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type {
  CouncilCreateRequest,
  CouncilMode,
  CouncilModelRef,
  CouncilRhythm,
  NativeBackendCatalogEntry,
} from '@contracts';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Tip } from '@/components/ui/tooltip';
import { IconArrowRightLeft, IconArrowUp, IconFileText, IconPlus, IconX } from '@/components/icons';
import { AgentModelSlot, workerBackendsOf } from './AgentModelSlot';

interface DraftSide {
  id: string;
  label: string;
  models: CouncilModelRef[];
}

function sameRef(a: CouncilModelRef | undefined, b: CouncilModelRef | undefined): boolean {
  return Boolean(a && b && a.backendId === b.backendId && a.profileId === b.profileId && a.model === b.model);
}

/** Picks initial models across distinct available agents so defaults are diverse out of the box. */
function seedRefs(workerBackends: readonly NativeBackendCatalogEntry[], count: number): CouncilModelRef[] {
  const picked: CouncilModelRef[] = [];
  for (const backend of workerBackends) {
    if (picked.length >= count) break;
    const defaultProfile = backend.profiles.find((p) => p.isDefault) ?? backend.profiles[0];
    const model = backend.defaultModel ?? backend.models[0]?.value ?? '';
    picked.push({
      backendId: backend.backendId,
      ...(defaultProfile ? { profileId: defaultProfile.id } : {}),
      model,
    });
  }
  return picked;
}

export function CouncilLaunch({
  backends,
  submitting,
  onCreate,
  onOpenProviderSettings,
}: {
  backends: readonly NativeBackendCatalogEntry[];
  submitting: boolean;
  onCreate: (req: CouncilCreateRequest) => void;
  onOpenProviderSettings: () => void;
}) {
  const { t } = useLingui();
  const workerBackends = useMemo(() => workerBackendsOf(backends), [backends]);
  const [mode, setMode] = useState<CouncilMode>('debate');
  const [topic, setTopic] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [rhythm, setRhythm] = useState<CouncilRhythm>('pause');
  const fileRef = useRef<HTMLInputElement>(null);

  const [sides, setSides] = useState<DraftSide[]>([]);
  const [judgeRef, setJudgeRef] = useState<CouncilModelRef | undefined>();
  const [prismRefs, setPrismRefs] = useState<CouncilModelRef[]>([]);
  const [observerRef, setObserverRef] = useState<CouncilModelRef | undefined>();

  useEffect(() => {
    const seeds = seedRefs(workerBackends, 4);
    if (!seeds.length) return;
    setSides((cur) => cur.length >= 2 ? cur : [
      { id: 'pro', label: t`正方`, models: [seeds[0]!] },
      { id: 'con', label: t`反方`, models: [seeds[1] ?? seeds[0]!] },
    ]);
    setJudgeRef((cur) => cur ?? seeds[2] ?? seeds[0]);
    setPrismRefs((cur) => cur.length >= 2 ? cur : (seeds.length >= 2 ? seeds.slice(0, Math.min(3, seeds.length)) : [seeds[0]!, seeds[0]!]));
    setObserverRef((cur) => cur ?? seeds[2] ?? seeds[0]);
  }, [workerBackends, t]);

  const noAgents = workerBackends.length === 0;
  const dupExactModel = useMemo(() => {
    const list = mode === 'debate' ? sides.flatMap((s) => s.models) : prismRefs;
    const keys = list.map((r) => `${r.backendId}:${r.profileId ?? ''}:${r.model}`);
    return keys.length >= 2 && new Set(keys).size < keys.length;
  }, [mode, sides, prismRefs]);

  const nextCandidate = (exclude: CouncilModelRef[]): CouncilModelRef | undefined => {
    const allSeeds = seedRefs(workerBackends, 8);
    const fresh = allSeeds.find((r) => !exclude.some((e) => sameRef(e, r)));
    return fresh ?? allSeeds[0];
  };

  const addModelToSide = (sideIdx: number) => {
    const target = sides[sideIdx];
    if (!target || target.models.length >= 3) return;
    const cand = nextCandidate(sides.flatMap((s) => s.models));
    if (!cand) return;
    setSides((prev) => prev.map((s, i) => i === sideIdx ? { ...s, models: [...s.models, cand] } : s));
  };

  const addSide = () => {
    if (sides.length >= 4) return;
    const cand = nextCandidate(sides.flatMap((s) => s.models));
    if (!cand) return;
    const n = sides.length + 1;
    setSides((prev) => [...prev, { id: `side-${n}`, label: t`立场 ${n}`, models: [cand] }]);
  };

  const swapTwoSides = () => {
    if (sides.length !== 2) return;
    setSides(([a, b]) => [
      { ...a!, models: b!.models },
      { ...b!, models: a!.models },
    ]);
  };

  const addPrismSlot = () => {
    if (prismRefs.length >= 4) return;
    const cand = nextCandidate(prismRefs);
    if (cand) setPrismRefs([...prismRefs, cand]);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setTopic(text.slice(0, 60_000));
    setSourceTitle(file.name);
  };

  const canSubmit = Boolean(topic.trim()) && workerBackends.length > 0 && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    if (mode === 'debate') {
      onCreate({
        mode,
        topic: topic.trim(),
        rhythm,
        sides: sides.map((s) => ({ id: s.id, label: s.label, models: s.models })),
        ...(judgeRef ? { judgeModel: judgeRef } : {}),
      });
    } else if (mode === 'prism') {
      onCreate({
        mode,
        topic: topic.trim(),
        rhythm,
        participants: prismRefs,
        ...(observerRef ? { observerModel: observerRef } : {}),
      });
    } else {
      onCreate({
        mode,
        topic: sourceTitle.trim() || topic.trim().slice(0, 48),
        documentText: topic.trim(),
        sourceTitle: sourceTitle.trim() || undefined,
        rhythm,
        participants: prismRefs,
        ...(observerRef ? { observerModel: observerRef } : {}),
      });
    }
  };

  const roleLabels = [t`修改`, t`补充`, t`问题`, t`结构`];

  return (
    <div className="mx-auto mt-8 flex w-full max-w-2xl flex-col gap-4 max-md:mt-2">
      <div className="flex items-center justify-start">
        <Segmented
          size="xs"
          ariaLabel={t`协作方式`}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'debate', label: t`辩论` },
            { value: 'prism', label: 'Prism' },
            { value: 'insight', label: t`审阅` },
          ]}
        />
      </div>

      {noAgents && (
        <Notice
          tone="warning"
          action={<Button size="xs" variant="secondary" onClick={onOpenProviderSettings}><Trans>前往配置</Trans></Button>}
        >
          <Trans>当前没有可用的 Agent 或模型，请先在设置中配置。</Trans>
        </Notice>
      )}

      {/* Hero composer */}
      <div className="overflow-hidden rounded-2xl bg-elevated shadow-composer">
        <textarea
          rows={mode === 'insight' ? 6 : 3}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            mode === 'debate'
              ? t`输入辩论命题，例如：首版应当独立建表，不复用 NativeSession`
              : mode === 'prism'
              ? t`输入要多角度探讨的问题…`
              : t`粘贴待审阅的文档、方案或 Diff…`
          }
          className="block w-full resize-none border-0 bg-transparent px-4 pt-4 pb-2 text-sm leading-6 text-fg outline-none placeholder:text-fg-4"
        />
        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1 pb-2.5">
          {mode === 'insight' && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.txt,.ts,.tsx,.js,.jsx,.json,.py,.go,.rs,.swift,.kt"
                className="hidden"
                onChange={(e) => void handleFile(e.target.files?.[0])}
              />
              <Button size="xs" variant="ghost" onClick={() => fileRef.current?.click()}>
                <IconFileText />
                <span><Trans>打开文件</Trans></span>
              </Button>
              <input
                value={sourceTitle}
                onChange={(e) => setSourceTitle(e.target.value)}
                placeholder={t`标题（可选）`}
                className="h-6 min-w-28 max-w-44 rounded-md border border-line bg-subtle px-2 text-xs text-fg outline-none placeholder:text-fg-4 focus:border-accent"
              />
            </>
          )}
          <button
            type="button"
            onClick={() => setRhythm((r) => r === 'pause' ? 'auto' : 'pause')}
            className="inline-flex h-7 items-center rounded-full px-2.5 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg"
          >
            {rhythm === 'pause' ? <Trans>每轮停顿</Trans> : <Trans>自动完成</Trans>}
          </button>
          <Button
            size="icon"
            variant="primary"
            className="ml-auto rounded-full"
            aria-label={t`开始协作`}
            busy={submitting}
            disabled={!canSubmit}
            onClick={submit}
          >
            <IconArrowUp />
          </Button>
        </div>
      </div>

      {/* Unified Agent & Model roster */}
      <section className="divide-y divide-line rounded-xl border border-line bg-bg">
        {mode === 'debate' ? (
          <>
            {sides.map((side, sideIdx) => (
              <div key={side.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <input
                  value={side.label}
                  onChange={(e) => setSides((prev) => prev.map((s, i) => i === sideIdx ? { ...s, label: e.target.value } : s))}
                  aria-label={t`立场名称`}
                  className="w-16 shrink-0 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-fg-2 outline-none hover:border-line focus:border-accent"
                />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  {side.models.map((ref, mIdx) => (
                    <AgentModelSlot
                      key={`${side.id}-${mIdx}`}
                      backends={workerBackends}
                      value={ref}
                      onChange={(next) => setSides((prev) => prev.map((s, i) => i === sideIdx ? { ...s, models: s.models.map((item, j) => j === mIdx ? next : item) } : s))}
                      onRemove={side.models.length > 1 ? () => setSides((prev) => prev.map((s, i) => i === sideIdx ? { ...s, models: s.models.filter((_, j) => j !== mIdx) } : s)) : undefined}
                    />
                  ))}
                  {side.models.length < 3 && (
                    <Button size="xs" variant="ghost" onClick={() => addModelToSide(sideIdx)}>
                      <IconPlus />
                      <span><Trans>添加</Trans></span>
                    </Button>
                  )}
                </div>
                {sides.length === 2 && sideIdx === 1 && (
                  <Tip label={t`互换正反方`}>
                    <Button size="icon-xs" variant="quiet" aria-label={t`互换正反方`} onClick={swapTwoSides}>
                      <IconArrowRightLeft />
                    </Button>
                  </Tip>
                )}
                {sides.length > 2 && (
                  <Button
                    size="icon-xs"
                    variant="quiet"
                    aria-label={t`移除立场`}
                    onClick={() => setSides((prev) => prev.filter((_, i) => i !== sideIdx))}
                  >
                    <IconX />
                  </Button>
                )}
              </div>
            ))}

            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 px-1 text-xs font-medium text-fg-2"><Trans>裁判</Trans></span>
                <AgentModelSlot
                  backends={workerBackends}
                  value={judgeRef}
                  onChange={setJudgeRef}
                />
              </div>
              {sides.length < 4 && (
                <Button size="xs" variant="ghost" onClick={addSide}>
                  <IconPlus />
                  <span><Trans>添加立场</Trans></span>
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-start gap-2 px-4 py-3">
              <span className="mt-1.5 w-16 shrink-0 text-xs font-medium text-fg-2">
                {mode === 'prism' ? <Trans>参与模型</Trans> : <Trans>审阅分工</Trans>}
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {prismRefs.map((ref, idx) => (
                  <AgentModelSlot
                    key={`slot-${idx}`}
                    backends={workerBackends}
                    value={ref}
                    badge={mode === 'insight' ? roleLabels[idx % roleLabels.length] : undefined}
                    onChange={(next) => setPrismRefs((list) => list.map((item, i) => i === idx ? next : item))}
                    onRemove={prismRefs.length > 2 ? () => setPrismRefs((list) => list.filter((_, i) => i !== idx)) : undefined}
                  />
                ))}
                {prismRefs.length < 4 && (
                  <Button size="xs" variant="ghost" onClick={addPrismSlot}>
                    <IconPlus />
                    <span><Trans>添加</Trans></span>
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <span className="w-16 shrink-0 text-xs font-medium text-fg-2"><Trans>汇总</Trans></span>
              <AgentModelSlot
                backends={workerBackends}
                value={observerRef}
                onChange={setObserverRef}
              />
            </div>
          </>
        )}
      </section>

      {dupExactModel && (
        <Notice tone="neutral">
          <Trans>当前存在重复的相同模型，选择不同 Agent 或模型能获得更有差异的视角。</Trans>
        </Notice>
      )}
    </div>
  );
}
