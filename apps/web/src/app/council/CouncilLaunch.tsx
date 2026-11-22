import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  COUNCIL_BUDGET,
  type CouncilAgent,
  type CouncilCreateRequest,
  type CouncilFormat,
  type CouncilReviewTask,
  type CouncilRhythm,
  type CouncilRole,
  type CouncilSummary,
  type NativeBackendCatalogEntry,
} from '@contracts';
import { Button } from '@/components/ui/button';
import { Segmented, Select } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { IconPlus, IconX } from '@/components/icons';
import { Composer } from '../session/Composer';
import { LEAD_ROLES, useCouncilLabels } from './model';
import { Halo, MarkTile } from './Speech';
import { cn } from '@/lib/utils';
import { useSettings } from '../state/stores';
import { SeatPicker, seatAgents, startingAgent } from './SeatPicker';

interface DraftSeat { key: string; role: CouncilRole; model?: CouncilAgent; task?: CouncilReviewTask }

/** Seat roles per format, in the order they are listed, with how many of each. */
const ROLES: Record<CouncilFormat, Array<{ role: CouncilRole; min: number; max: number; initial: number }>> = {
  ld: [{ role: 'pro', min: 1, max: 1, initial: 1 }, { role: 'con', min: 1, max: 1, initial: 1 }, { role: 'judge', min: 1, max: 1, initial: 1 }],
  roundtable: [{ role: 'debater', min: 2, max: 6, initial: 3 }, { role: 'moderator', min: 1, max: 1, initial: 1 }],
  prism: [{ role: 'participant', min: 2, max: 4, initial: 3 }, { role: 'observer', min: 1, max: 1, initial: 1 }],
  review: [{ role: 'reviewer', min: 1, max: 4, initial: 3 }, { role: 'editor', min: 1, max: 1, initial: 1 }],
};
const TASKS: CouncilReviewTask[] = ['correct', 'augment', 'diagnose', 'restructure'];
const FORMATS: CouncilFormat[] = ['ld', 'roundtable', 'prism', 'review'];
const ROUND_CHOICES = Array.from({ length: COUNCIL_BUDGET.maxRounds - COUNCIL_BUDGET.minRounds + 1 }, (_, i) => String(COUNCIL_BUDGET.minRounds + i));

let seatKey = 0;
const nextKey = () => `seat-${seatKey += 1}`;

/**
 * The seats a format starts with: those of its last discussion, where their Agents are still there, else the
 * available Agents in turn.
 */
function initialSeats(format: CouncilFormat, models: CouncilAgent[], previous?: CouncilSummary, still?: (agent: CouncilAgent) => CouncilAgent | undefined): DraftSeat[] {
  if (previous?.seats.length) {
    return previous.seats.map((seat, at) => {
      const model = still?.(seat.model) ?? (models.length ? models[at % models.length] : undefined);
      return { key: nextKey(), role: seat.role, ...(model ? { model } : {}), ...(seat.task ? { task: seat.task } : {}) };
    });
  }
  const seats: DraftSeat[] = [];
  let at = 0;
  for (const rule of ROLES[format]) {
    for (let i = 0; i < rule.initial; i += 1) {
      const model = models.length ? models[at % models.length] : undefined;
      at += 1;
      seats.push({ key: nextKey(), role: rule.role, ...(model ? { model } : {}), ...(rule.role === 'reviewer' ? { task: TASKS[i % TASKS.length] } : {}) });
    }
  }
  return seats;
}

export function CouncilLaunch({ backends, recent, onCreate, onOpenProviderSettings, onError }: {
  backends: readonly NativeBackendCatalogEntry[];
  /** The discussions held so far, newest first; undefined until read. Each format starts from its last one. */
  recent: readonly CouncilSummary[] | undefined;
  onCreate: (request: CouncilCreateRequest) => Promise<boolean>;
  onOpenProviderSettings: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  // Seats start on the available Agents in turn, so a discussion seats different ones unless the reader picks
  // otherwise; quick chat only when no Agent is there.
  const agents = seatAgents(backends);
  const workers = agents.some((entry) => entry.backendId !== 'chat') ? agents.filter((entry) => entry.backendId !== 'chat') : agents;
  const nativeBackendDefaults = useSettings((settings) => settings.nativeBackendDefaults);
  const auxiliaryModels = useSettings((settings) => settings.auxiliaryModels);
  const enterBehavior = useSettings((settings) => settings.composerEnterBehavior);
  const models: CouncilAgent[] = workers.map((entry) => startingAgent(entry, { nativeBackendDefaults, auxiliaryModels }));
  const [format, setFormat] = useState<CouncilFormat>('ld');
  const [seats, setSeats] = useState<Partial<Record<CouncilFormat, DraftSeat[]>>>({});
  const [rounds, setRounds] = useState<Partial<Record<CouncilFormat, number>>>({});
  const [rhythms, setRhythms] = useState<Partial<Record<CouncilFormat, CouncilRhythm>>>({});
  const [busy, setBusy] = useState(false);

  const agentKey = models.map((model) => `${model.backendId}:${model.profileId}:${model.model ?? ''}`).join(',');
  const listed = recent !== undefined;
  // The page opens on the format last used, once the discussions are read.
  const opened = useRef(false);
  useEffect(() => {
    if (!listed || opened.current) return;
    opened.current = true;
    const last = recent[0];
    if (!last) return;
    setFormat(last.format);
  }, [listed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // The last discussions are read first, so a format does not open on Agents in turn and then jump to its last seats.
    if (!listed) return;
    const previous = recent.find((item) => item.format === format);
    if (previous && rounds[format] === undefined) setRounds((current) => ({ ...current, [format]: previous.maxRounds }));
    if (previous && rhythms[format] === undefined) setRhythms((current) => ({ ...current, [format]: previous.rhythm }));
    setSeats((current) => {
      const drafted = current[format];
      // A seat that named no model (a discussion from before seats named one) takes what its Agent would start on now.
      const still = (agent: CouncilAgent) => {
        const entry = agents.find((item) => item.backendId === agent.backendId);
        if (!entry) return undefined;
        return agent.model && entry.profiles.some((profile) => profile.id === agent.profileId) ? agent : startingAgent(entry, { nativeBackendDefaults, auxiliaryModels }, agent.profileId);
      };
      if (!drafted) return { ...current, [format]: initialSeats(format, models, previous, still) };
      // Seats drafted before the Agents were known take them now, in turn, as they would have at first.
      if (!models.length || drafted.every((seat) => seat.model)) return current;
      return { ...current, [format]: drafted.map((seat, at) => seat.model ? seat : { ...seat, model: models[at % models.length]! }) };
    });
  }, [format, agentKey, listed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Until the seats are drafted, the stage stands with the format's opening seats, their Agents and models skeletons.
  const pending = seats[format] === undefined;
  const list = seats[format] ?? ROLES[format].flatMap((rule) => Array.from({ length: rule.initial }, (_, i): DraftSeat => ({ key: `pending-${rule.role}-${i}`, role: rule.role })));
  const setList = (next: DraftSeat[]) => setSeats((current) => ({ ...current, [format]: next }));
  const roundCount = rounds[format] ?? (format === 'ld' ? 4 : 3);
  const rhythm = rhythms[format] ?? 'pause';
  const noModels = backends.length > 0 && agents.length === 0;
  const ready = list.length > 0 && list.every((seat) => seat.model);

  const submit = async (text: string): Promise<boolean> => {
    if (!ready || busy) return false;
    setBusy(true);
    try {
      return await onCreate({
        format,
        topic: format === 'review' ? '' : text.trim(),
        ...(format === 'review' ? { document: text.trim() } : {}),
        seats: list.map((seat) => ({ role: seat.role, model: seat.model!, ...(seat.task ? { task: seat.task } : {}) })),
        ...(format === 'ld' || format === 'roundtable' ? { maxRounds: roundCount } : {}),
        rhythm,
      });
    } finally {
      setBusy(false);
    }
  };

  const pickerProps = (seat: DraftSeat) => ({
    backends: agents,
    value: seat.model,
    disabled: busy,
    onChange: (model: CouncilAgent) => setList(list.map((item) => (item.key === seat.key ? { ...item, model } : item))),
  });
  const remove = (seat: DraftSeat) => (
    <Button size="icon-sm" variant="quiet" className="absolute top-2 right-2" aria-label={t`移除`} onClick={() => setList(list.filter((item) => item.key !== seat.key))}><IconX /></Button>
  );

  /**
   * A seat on the stage: its Agent's mark on a tile, lit in the mark's colour, its role, and the model it runs on as
   * its name. A reviewer also picks how it reads.
   */
  const podium = (seat: DraftSeat | undefined, size: 'lg' | 'md', removable = false) => seat && (
    <div key={seat.key} className={cn('relative isolate flex min-w-0 flex-col items-center overflow-hidden rounded-3xl bg-subtle text-center', size === 'lg' ? 'gap-2.5 px-3 pt-5 pb-4 @lg:px-6 @lg:pt-7 @lg:pb-5' : 'gap-2 px-4 pt-5 pb-4')}>
      {seat.model && <Halo backend={seat.model.backendId} />}
      {pending ? <Skeleton className={size === 'lg' ? 'size-16 rounded-2xl' : 'size-11 rounded-xl'} />
        : seat.model ? <MarkTile backend={seat.model.backendId} size={size} />
        : <span className={cn('bg-bg', size === 'lg' ? 'size-16 rounded-2xl' : 'size-11 rounded-xl')} />}
      <span className="text-xs font-semibold tracking-widest text-fg-3">{labels.roleOf(seat.role)}</span>
      {pending ? <Skeleton className={size === 'lg' ? 'h-7 w-full max-w-36 rounded-lg' : 'h-6.5 w-full max-w-28 rounded-lg'} /> : <SeatPicker {...pickerProps(seat)} stage={size} />}
      {seat.role === 'reviewer' && pending && <Skeleton className="mt-1 h-7 w-full max-w-48 rounded-lg" />}
      {seat.role === 'reviewer' && !pending && (
        <Segmented
          size="xs"
          ariaLabel={t`审阅角度`}
          className="mt-1"
          value={seat.task ?? 'correct'}
          onChange={(task) => setList(list.map((item) => (item.key === seat.key ? { ...item, task } : item)))}
          options={TASKS.map((task) => ({ value: task, label: labels.task(task) }))}
        />
      )}
      {removable && !pending && remove(seat)}
    </div>
  );

  /** The seat that leads the format (the judge, the moderator): a bench below the stage, not a podium on it. */
  const bench = (seat: DraftSeat | undefined) => seat && (
    <div key={seat.key} className="mx-auto flex w-full max-w-md min-w-0 items-center justify-center gap-2 rounded-2xl bg-subtle px-4 py-2.5">
      <span className="shrink-0 text-xs font-semibold tracking-widest text-fg-3">{labels.roleOf(seat.role)}</span>
      {pending ? <Skeleton className="h-7 w-full max-w-32 rounded-md" /> : <SeatPicker {...pickerProps(seat)} />}
    </div>
  );

  const leadRule = ROLES[format].find((rule) => LEAD_ROLES.has(rule.role));
  const stage = format === 'ld' ? (
    // LD: the two sides face each other, the judge on the bench below.
    <div className="@container flex flex-col gap-3" aria-busy={pending || undefined}>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 @lg:gap-3">
        {podium(list.find((seat) => seat.role === 'pro'), 'lg')}
        <span className="text-center text-base font-extrabold tracking-tight text-fg-4 italic @lg:text-xl" aria-hidden>VS</span>
        {podium(list.find((seat) => seat.role === 'con'), 'lg')}
      </div>
      {bench(list.find((seat) => seat.role === 'judge'))}
    </div>
  ) : (
    <div className="@container flex flex-col gap-3" aria-busy={pending || undefined}>
      <div className="grid gap-3 @md:grid-cols-2 @xl:grid-cols-3">
        {ROLES[format].filter((rule) => rule !== leadRule).flatMap((rule) => {
          const ofRole = list.filter((seat) => seat.role === rule.role);
          return [
            ...ofRole.map((seat) => podium(seat, 'md', ofRole.length > rule.min)),
            ...(rule.max > 1 && ofRole.length < rule.max ? [(
              <Button
                key={`add-${rule.role}`}
                variant="quiet"
                disabled={busy || pending}
                className="h-auto min-h-40 rounded-3xl border border-dashed border-line"
                onClick={() => {
                  const model = models[list.length % Math.max(1, models.length)];
                  const seat: DraftSeat = { key: nextKey(), role: rule.role, ...(model ? { model } : {}), ...(rule.role === 'reviewer' ? { task: TASKS[ofRole.length % TASKS.length] } : {}) };
                  const last = list.findLastIndex((item) => item.role === rule.role);
                  setList([...list.slice(0, last + 1), seat, ...list.slice(last + 1)]);
                }}
              >
                <IconPlus /><span>{labels.roleOf(rule.role)}</span>
              </Button>
            )] : []),
          ];
        })}
      </div>
      {leadRule && bench(list.find((seat) => seat.role === leadRule.role))}
    </div>
  );

  return (
    <div className="mx-auto mt-8 flex w-full max-w-2xl flex-col gap-4 px-4 pb-16 max-md:mt-2">
      <Segmented
        size="xs"
        ariaLabel={t`协作方式`}
        className="self-start"
        value={format}
        onChange={setFormat}
        options={FORMATS.map((value) => ({ value, label: labels.format(value) }))}
      />

      {noModels && (
        <Notice tone="warning" action={<Button size="xs" variant="secondary" onClick={onOpenProviderSettings}><Trans>前往配置</Trans></Button>}>
          <Trans>没有可用的 Agent</Trans>
        </Notice>
      )}

      {stage}

      <Composer
        key={format}
        variant="hero"
        autoFocus
        projectId=""
        draftKey={`council:${format}`}
        windowDrop={false}
        attachmentsAllowed={false}
        fileMentions={false}
        referencesEnabled={false}
        persistReferences={false}
        references={[]}
        onReferencesChange={() => {}}
        placeholder={{ ld: t`辩题，例如：首版应当先做 Web 端`, roundtable: t`要讨论的问题`, prism: t`要多角度回答的问题`, review: t`粘贴要审阅的文档或方案` }[format]}
        enterBehavior={enterBehavior}
        disabled={busy}
        submitDisabled={!ready || busy}
        onSubmit={(text) => submit(text)}
        onError={onError}
      />

      <div className="flex flex-wrap items-center gap-3">
        {(format === 'ld' || format === 'roundtable') && (
          <Select
            label={t`轮数`}
            className="w-28"
            value={String(roundCount)}
            onChange={(value) => setRounds((current) => ({ ...current, [format]: Number(value) }))}
            options={ROUND_CHOICES.map((value) => ({ value, label: t`最多 ${value} 轮` }))}
          />
        )}
        <Segmented
          size="xs"
          ariaLabel={t`节奏`}
          value={rhythm}
          onChange={(value) => setRhythms((current) => ({ ...current, [format]: value }))}
          options={[{ value: 'pause', label: t`每轮暂停` }, { value: 'auto', label: t`自动进行` }]}
        />
      </div>
    </div>
  );
}
