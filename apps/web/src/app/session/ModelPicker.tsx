import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { ModelStatus, NativeBackendUsage } from '@contracts';
import { invalidateModelUsage, readLiveUsage, usageRevision, writeLiveUsage } from '@/lib/catalog-cache';
export { invalidateModelUsage };
import { IconCheck, IconChevronDown, IconRotateCw, IconSearch, IconServer } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch, Spinner, StatusDot } from '@/components/ui/controls';
import { contextChoices, isOn, optionLabel, paramHint, paramKind, paramTitle, toggledValue, type ModelParam, type ParamKind } from '@/lib/models';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/store';
import { accountFigures, loadHint, loadTone, statusQuotaTags } from '@/lib/usage';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import type { Choice } from './model';
import { isComposingKey } from './composerKeyboard';
import { useLingering, WAIT_GRACE_MS } from './sessionLayout';

const kindOrder: Record<ParamKind, number> = { effort: 0, toggle: 1, select: 2, fast: 3, max: 4 };
const mobilePickerTriggerClass = 'inline-flex h-11 w-full min-w-0 items-center justify-between gap-1.5 rounded-xl border border-line-strong bg-bg px-3 text-base text-fg-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg';
/**
 * The same control on a pointer device. It is one row tall and sits at the end of the row, exactly
 * like the switches beside it: a labelled box on its own line made the Effort parameter look like a
 * different kind of setting from Thinking, Fast and Max, which are three rows of the same height.
 */
const desktopPickerTriggerClass = 'inline-flex h-6 min-w-0 items-center justify-between gap-1 rounded-md border border-line-strong bg-bg px-2 text-xs text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg';

function SlidingSegments({ param, onChange, disabled, options = param.options, value = param.value, label }: { param: ModelParam; onChange: (value: string) => void; disabled?: boolean; options?: ModelParam['options']; value?: string; label?: string }) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const count = options.length;
  return (
    <div role="radiogroup" aria-label={label ?? paramTitle(param)} className="relative grid rounded-lg bg-muted p-0.5" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-md bg-elevated ring-[0.5px] ring-line-strong shadow-soft transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)]"
        style={{ width: `calc((100% - 4px) / ${count})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((option, optionIndex) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={optionIndex === index ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
            const target = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : step ? (index + step + count) % count : -1;
            if (target < 0) return;
            event.preventDefault();
            onChange(options[target]!.value);
            (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]')[target])?.focus();
          }}
          className={cn('relative h-11 min-w-0 truncate rounded-md px-1 text-sm font-medium outline-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:h-6 md:text-xs', option.value === value ? 'text-fg' : 'text-fg-3 hover:text-fg')}
        >
          {optionLabel(param, option.value)}
        </button>
      ))}
    </div>
  );
}

function ParamControl({ param, onChange, disabled, mobile = false }: { param: ModelParam; onChange: (value: string) => void; disabled?: boolean; mobile?: boolean }) {
  const kind = paramKind(param);
  if (kind === 'effort' || kind === 'select') {
    const title = paramTitle(param);
    // More than four steps cannot be a segment strip on any width: every label would be ellipsised
    // and the reader could not see which level is selected. Nine effort levels is the normal case.
    const asList = mobile || param.options.length > 4;
    const control = asList ? (
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={title} disabled={disabled} className={cn('group/param', mobile ? mobilePickerTriggerClass : desktopPickerTriggerClass)}>
          <span className={cn('min-w-0 truncate', !mobile && 'max-w-36')}>{optionLabel(param, param.value)}</span>
          <IconChevronDown aria-hidden className="size-3 shrink-0 text-fg-4 transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)] group-data-[state=open]/param:rotate-180" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align={mobile ? 'start' : 'end'} aria-label={title} className="w-[min(300px,calc(100vw-24px))]">
          <DropdownMenuRadioGroup value={param.value} onValueChange={onChange}>
            {param.options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value} disabled={disabled} className={cn('px-2', option.value === param.value ? 'text-fg' : 'text-fg-2')}>
                <span className="min-w-0 flex-1 truncate">{optionLabel(param, option.value)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : <SlidingSegments param={param} onChange={onChange} disabled={disabled} />;
    // A touch sheet stacks label over control, because a 44px control cannot share a row with its
    // own label. A pointer device has no such constraint, so the row matches the switches'.
    if (mobile) return <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-fg-2">{title}</span>{control}</div>;
    return (
      <div className="flex min-h-6 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-2">{title}</span>
        <span className="flex shrink-0 items-center">{control}</span>
      </div>
    );
  }
  const on = isOn(param);
  const row = (
    <div className="flex min-h-11 cursor-default items-center gap-3 md:min-h-0">
      <span className="flex min-w-0 flex-1 flex-col">
        {/*
          One label shape for every parameter: the title, in the same size and colour as the rest.
          The glyph before Fast and the inverted MAX chip this used to carry were three different
          treatments of the same thing — a parameter's name — and the panel read as noise. What a
          row *does* is said by its hint and by the switch already on the right.
        */}
        <span className="truncate text-xs font-medium text-fg-2">
          {paramTitle(param)}
        </span>
        {paramHint(param) && <span className="truncate text-2xs text-fg-3">{paramHint(param)}</span>}
      </span>
      {/* Fast is a switch only: "follow the CLI's own setting" read as a third state nobody could see the effect of. */}
      <Switch checked={on} disabled={disabled} onCheckedChange={(checked) => onChange(toggledValue(param, checked))} aria-label={paramTitle(param)} />
    </div>
  );
  if (kind !== 'max') return row;
  // Max owns the widest window; the remaining documented windows stay pickable underneath, so
  // turning Max off never strands the reader on a window they did not choose. While Max *is* on the
  // strip is not drawn: it would show no selection (none of its windows is the current one) and the
  // switch above already says which window is in force. Turning Max off returns to the fallen-back
  // window, and the strip comes back for a different one.
  const windows = contextChoices(param);
  return (
    <div className="flex flex-col gap-1.5">
      {row}
      {windows.length > 1 && !on && (
        // The window strip is the same row shape as everything above it, so Max reads as one
        // setting with a switch and a fallback rather than two unrelated controls.
        <div className="flex min-h-6 items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-2">Context</span>
          <span className="flex shrink-0 items-center">
            <SlidingSegments param={param} options={windows} value={param.value} onChange={onChange} disabled={disabled} label="Context" />
          </span>
        </div>
      )}
    </div>
  );
}

function bareModelId(modelId: string, activeProviderId?: string): string | undefined {
  const sep = modelId.indexOf('\u0000');
  if (sep < 0) return modelId;
  return activeProviderId && modelId.slice(0, sep) === activeProviderId ? modelId.slice(sep + 1) : undefined;
}

export function modelUsageStatus(
  usage: NativeBackendUsage | undefined,
  model: Pick<Choice, 'id' | 'aliases'>,
  activeProviderId?: string,
  selectedEffort?: string,
  isSelected?: boolean,
): ModelStatus | undefined {
  if (!usage) return undefined;
  const bare = bareModelId(model.id, activeProviderId);
  if (bare === undefined) return undefined;
  const direct = usage.models[bare];
  if (direct) return direct;
  const aliases = model.aliases;
  if (!aliases?.length) return undefined;
  if (isSelected && selectedEffort && selectedEffort !== 'default') {
    const effortId = `${bare}-${selectedEffort}`;
    if (aliases.includes(effortId) && usage.models[effortId]) return usage.models[effortId];
  }
  let picked: ModelStatus | undefined;
  let pickedPercent = -1;
  for (const alias of aliases) {
    const candidate = usage.models[alias];
    if (!candidate) continue;
    const used = candidate.quota?.depleted ? 100 : (candidate.quota?.usedPercent ?? -1);
    if (!picked || used > pickedPercent) {
      picked = candidate;
      pickedPercent = used;
    }
  }
  return picked;
}

const loadToneClass = { danger: 'text-danger', warning: 'text-warning', muted: 'text-fg-4' } as const;
/** The account row reads at the parameters' weight; a model row's tags sit a step quieter. */
const figureToneClass = { danger: 'text-danger', warning: 'text-warning', muted: 'text-fg-3' } as const;

/** A model's quota and load, as short figures after its name; nothing when the provider reported neither. */
function ModelStatusTags({ status }: { status?: ModelStatus }) {
  if (!status) return null;
  const tags = statusQuotaTags(status);
  return (
    <>
      {tags.map((tag, index) => (
        <span key={`${tag.text}:${index}`} title={tag.hint} className={cn('shrink-0 text-2xs tabular-nums', loadToneClass[tag.tone])}>{tag.text}</span>
      ))}
      {status.loadPercent !== undefined && (
        <span title={loadHint(status.loadPercent)} className={cn('shrink-0 text-2xs tabular-nums', loadToneClass[loadTone(status.loadPercent)])}>Load {status.loadPercent}%</span>
      )}
    </>
  );
}

export function selectionTags(params: ModelParam[]) {
  const effort = params.find((param) => paramKind(param) === 'effort');
  const thinking = params.find((param) => paramKind(param) === 'toggle' && param.id === 'thinking');
  const fast = params.find((param) => paramKind(param) === 'fast');
  const max = params.find((param) => paramKind(param) === 'max');
  const context = params.find(param => param.id === 'context' && paramKind(param) === 'select');
  return {
    // An empty value means "the family's own default", which the model's name already says; only a
    // named effort is worth repeating next to it.
    effort: thinking && !isOn(thinking) ? 'No thinking' : effort?.value && effort.value !== 'default' ? optionLabel(effort, effort.value) : undefined,
    fast: Boolean(fast && isOn(fast)),
    max: Boolean(max && isOn(max)),
    context: context && context.value !== 'default' ? optionLabel(context, context.value) : undefined,
  };
}

/**
 * The pixel height a model list needs on a pointer device: 32px rows, a 24px heading for the first
 * group and 30px for each one after it, inside the list's 4px padding. Mirrors the classes below.
 */
function modelListHeight(models: Choice[], fallbackGroup?: string) {
  let height = 8;
  let group: string | undefined | null = null;
  let headings = 0;
  for (const model of models) {
    const next = model.group ?? fallbackGroup;
    if (next !== group) { if (next) { height += headings ? 30 : 24; headings += 1; } group = next; }
    height += 32;
  }
  return height;
}

/** Tallest the list grows before it scrolls. */
const MODEL_LIST_MAX = 256;

/** One provider in a provider→models menu: the profile and the choices it offers. */
export interface ModelProviderChoices {
  id: string;
  label: string;
  /** Composed choices (`profileId\0model`), the same ids the flat list uses. */
  models: Choice[];
  /** No catalog yet: the row says so instead of looking empty. */
  loading?: boolean;
  issue?: string;
  /**
   * The agent this provider runs under, when the column lists several agents (a new session).
   * Consecutive providers of one agent sit under its name; an agent with one provider is one row.
   */
  agent?: { id: string; label: string; icon: ReactNode };
  /** The provider an agent's column opens on when it is not the one in force (its saved default). */
  preferred?: boolean;
  /** The model choice id last remembered on this provider (`profileId\0model` or `\u0001…`). */
  rememberedModelId?: string;
}

/** The agents of an agent column, in list order, each with its providers. */
function agentGroups(providers: ModelProviderChoices[]) {
  const groups: Array<{ agent: NonNullable<ModelProviderChoices['agent']>; providers: ModelProviderChoices[] }> = [];
  for (const provider of providers) {
    if (!provider.agent) continue;
    const group = groups.find((entry) => entry.agent.id === provider.agent!.id);
    if (group) group.providers.push(provider); else groups.push({ agent: provider.agent, providers: [provider] });
  }
  return groups;
}

/** What a model found by a search across the column is filed under. */
function sourceTitle(provider: ModelProviderChoices, providers: ModelProviderChoices[]) {
  const agent = provider.agent;
  if (!agent) return provider.label;
  return providers.filter((other) => other.agent?.id === agent.id).length > 1 ? `${agent.label} · ${provider.label}` : agent.label;
}

function revealInList(container: HTMLElement | null, item: HTMLElement | null, align: 'center' | 'nearest') {
  if (!container || !item) return;
  const top = item.offsetTop;
  const height = item.offsetHeight;
  const viewHeight = container.clientHeight;
  if (!viewHeight || !height) return;
  if (align === 'center') {
    const target = top - (viewHeight - height) / 2;
    container.scrollTop = Math.max(0, Math.min(target, container.scrollHeight - viewHeight));
    return;
  }
  const style = getComputedStyle(container);
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const padBottom = Number.parseFloat(style.paddingBottom) || 0;
  if (top - padTop < container.scrollTop) container.scrollTop = Math.max(0, top - padTop);
  else if (top + height + padBottom > container.scrollTop + viewHeight) {
    container.scrollTop = Math.min(top + height + padBottom - viewHeight, container.scrollHeight - viewHeight);
  }
}

/**
 * Runs inside the portalled popover content: Radix's Portal mounts its DOM after `open` renders,
 * so reading or scrolling the listboxes from `ModelPicker` itself runs before they exist.
 */
function PickerScrollSync({ listRef, agentsRef, providersRef, activeOptionId, revealKey, columnKey, layoutKey, hasCurrent, manual }: {
  listRef: RefObject<HTMLDivElement | null>;
  agentsRef: RefObject<HTMLDivElement | null>;
  providersRef: RefObject<HTMLDivElement | null>;
  activeOptionId: string | undefined;
  revealKey: string;
  columnKey: string;
  layoutKey: string;
  hasCurrent: boolean;
  manual: boolean;
}) {
  const lastReveal = useRef<string | undefined>(undefined);
  const lastColumn = useRef<string | undefined>(undefined);
  const lastLayout = useRef<string | undefined>(undefined);
  const lastHadCurrent = useRef(false);
  useLayoutEffect(() => {
    const revealChanged = lastReveal.current !== revealKey;
    const loadedCurrent = !manual && hasCurrent && !lastHadCurrent.current;
    const layoutChanged = lastLayout.current !== layoutKey;
    lastReveal.current = revealKey;
    lastLayout.current = layoutKey;
    lastHadCurrent.current = hasCurrent;
    if (lastColumn.current !== columnKey || layoutChanged) {
      lastColumn.current = columnKey;
      revealInList(agentsRef.current, agentsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? null, 'nearest');
      revealInList(providersRef.current, providersRef.current?.querySelector<HTMLElement>('[aria-selected="true"], [data-preview="true"]') ?? null, 'nearest');
    }
    const item = activeOptionId ? document.getElementById(activeOptionId) : null;
    revealInList(listRef.current, item, revealChanged || loadedCurrent ? 'center' : 'nearest');
  }, [listRef, agentsRef, providersRef, activeOptionId, revealKey, columnKey, layoutKey, hasCurrent, manual]);
  return null;
}

export function ModelPicker({ models, value, params = [], onChange, onParamChange, disabled, side = 'top', align = 'start', placeholder, className, inlineParams = false, loadUsage, refreshCatalog, usageScopeKey, providers, activeProviderId, providerLabel, onPreviewProvider, onSelectProvider, leading, sourceLabel, labelClassName, loading = false, refreshing = false, error, onRetry, open: openProp, onOpenChange }: {
  models: Choice[];
  placeholder?: string;
  value?: string;
  params?: ModelParam[];
  onChange: (id: string) => void;
  onParamChange?: (id: string, value: string) => void;
  disabled?: boolean;
  /** Shows a spinner in the trigger once the catalog has been arriving for a while; a quick read shows nothing. */
  loading?: boolean;
  /** A catalog read is in flight, also one behind a list already shown; holds the retry. */
  refreshing?: boolean;
  /** Why the last catalog read failed. */
  error?: string;
  /**
   * Reads the catalog again. An empty list without a diagnostic retries directly; a failure opens
   * the existing popover so its reason and retry remain readable on touch screens too.
   */
  onRetry?: () => void;
  side?: 'top' | 'bottom';
  /**
   * The menu's edge on its trigger's, so the list stays put as the trigger's tags change width:
   * `end` where the trigger closes a right-aligned row, `start` where it opens a left-aligned one.
   */
  align?: 'start' | 'end';
  className?: string;
  /** Show parameters below the trigger in a settings sheet, outside the model list. */
  inlineParams?: boolean;
  /** Reads account quota and per-model load, keyed by choice id, before opening and while the list is open. */
  loadUsage?: (signal: AbortSignal) => Promise<NativeBackendUsage>;
  /** Re-reads the catalog as the list opens; a failed read leaves the last known list in place. */
  refreshCatalog?: (signal: AbortSignal) => Promise<void> | void;
  /**
   * The agent, provider and session the figures belong to. Two backends can share a profile id,
   * so `activeProviderId` alone cannot tell a switch; this stable key drops the old read instead
   * of mislabelling it. The callbacks stay out of the dependency list: they are recreated each
   * render and would otherwise re-read on every paint.
   */
  usageScopeKey?: string;
  /**
   * Every provider of the agent being started, for a provider→models menu. Absent — an open
   * conversation, whose provider cannot change — keeps the flat list.
   */
  providers?: ModelProviderChoices[];
  activeProviderId?: string;
  /** The fixed provider of an existing conversation; shown in the menu without offering a switch. */
  providerLabel?: string;
  /** A provider other than the one in force was brought up in the column, so its list can be read. */
  onPreviewProvider?: (id: string) => void;
  /**
   * When present, clicking an available agent or provider immediately switches to it (and its
   * remembered model) while keeping the menu open; omitted in live-session menus that must confirm
   * a model before migrating the conversation.
   */
  onSelectProvider?: (id: string) => void;
  /** Before the model's name in the trigger: the agent's mark when the menu also picks the agent. */
  leading?: ReactNode;
  /** Shown at the top of the popover when agents and models are read from a linked server. */
  sourceLabel?: string;
  /** The model's name in the trigger, where the trigger is set larger than the composer's (a council seat). */
  labelClassName?: string;
  /** Opened by its host rather than its trigger (a mention written in the draft); `onOpenChange` hears every change. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const shownPlaceholder = placeholder ?? t`默认模型`;
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const setOpen = useCallback((next: boolean) => { if (!controlled) setOpenState(next); onOpenChangeRef.current?.(next); }, [controlled]);
  const [openCycle, setOpenCycle] = useState(0);
  const [query, setQuery] = useState('');
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef<HTMLDivElement>(null);
  const providersRef = useRef<HTMLDivElement>(null);
  const connectionRevision = useStore(usageRevision, (state) => state.value);
  const usageScope = `${connectionRevision}|${usageScopeKey ?? ''}|${activeProviderId ?? ''}`;
  const usageCacheKey = usageScopeKey ?? '';
  const [usageRead, setUsageRead] = useState<{ scope: string; usage?: NativeBackendUsage; loading: boolean }>();
  // A scope read before keeps its figures while this open re-reads them, so the account row is
  // there from the first frame rather than pushing the search and the list down when it lands.
  const usage = !loadUsage ? undefined : usageRead?.scope === usageScope ? usageRead.usage : usageCacheKey ? readLiveUsage(usageCacheKey) : undefined;
  const usageLoading = Boolean(loadUsage) && usageRead?.scope === usageScope && usageRead.loading;
  const usageFigures = usage?.account ? accountFigures(usage.account) : [];
  const hasUsageLoader = Boolean(loadUsage);
  const loadUsageRef = useRef(loadUsage);
  loadUsageRef.current = loadUsage;
  const refreshUsageRef = useRef<() => void>(() => undefined);
  const refreshCatalogRef = useRef(refreshCatalog);
  // Opening a failed catalog reveals its diagnostic; retry is an explicit action inside it.
  refreshCatalogRef.current = error?.trim() ? undefined : refreshCatalog;
  // A provider column needs the width of a pointer device's popover; a phone sheet keeps the one
  // grouped list, whose headings already say which provider each run of models came from.
  const picksAgent = !isMobile && providers !== undefined && onSelectProvider !== undefined;
  const currentProvider = providers?.find((provider) => provider.id === activeProviderId);
  const providerCount = providers?.length ?? 0;
  const providerColumn = !isMobile && (providerCount > 1 || (picksAgent && providerCount > 0));
  const agentColumn = providerColumn && Boolean(providers?.some((provider) => provider.agent));
  const groups = useMemo(() => agentColumn && providers ? agentGroups(providers) : [], [agentColumn, providers]);
  /** Agents in one column, the previewed agent's providers in a second, its models in the third. */
  const providerTier = groups.some((group) => group.providers.length > 1);
  const [previewProviderId, setPreviewProviderId] = useState(activeProviderId);
  const previewProvider = providers?.find((provider) => provider.id === previewProviderId) ?? providers?.[0];
  const activeProvider = currentProvider ?? (picksAgent ? undefined : providers?.[0]);
  /** Whether the listed provider is the one in force; parameters and quota only describe that one. */
  const previewIsActive = picksAgent && !activeProvider ? false : !providerColumn || previewProvider?.id === activeProvider?.id;
  const selectableModels = providerColumn ? previewProvider?.models : picksAgent && !activeProvider ? undefined : models;
  /*
   * Beside the providers the list is as tall as the longest provider's needs (or the provider
   * column's), so moving between providers never resizes it; a short provider leaves room only
   * when another one needs it. A loading or empty provider shows a one-line note in the same space.
   */
  const providerListHeight = useMemo(() => {
    if (!providerColumn || !providers) return 0;
    // Each column scrolls on its own; the list is as tall as the tallest of them needs.
    const rowsOf = (count: number) => 8 + count * 34 - 2;
    const column = agentColumn ? Math.max(rowsOf(groups.length), ...groups.map((group) => providerTier ? rowsOf(group.providers.length) : 0)) : rowsOf(providers.length);
    // Another agent's list still on its way may be long; the height is held once the menu opens, so it is allowed for.
    const lists = providers.map((provider) => provider.models.length ? modelListHeight(provider.models, providerLabel) : agentColumn && !provider.issue ? MODEL_LIST_MAX : 72);
    return Math.min(MODEL_LIST_MAX, Math.max(column, ...lists));
  }, [providerColumn, providers, providerLabel, agentColumn, groups, providerTier]);
  // Prefetch independently of the catalog. One scope owns its request, and opening during that
  // read reuses it; a switch aborts it before another scope can receive its answer.
  useEffect(() => {
    let active = true;
    let pending: AbortController | undefined;
    const refreshUsage = () => {
      const load = loadUsageRef.current;
      if (!active || pending || !load) return;
      const controller = new AbortController();
      pending = controller;
      setUsageRead(previous => ({
        scope: usageScope,
        usage: previous?.scope === usageScope ? previous.usage : usageCacheKey ? readLiveUsage(usageCacheKey) : undefined,
        loading: true,
      }));
      void load(AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])).then(next => {
        if (!active || controller.signal.aborted) return;
        if (usageCacheKey) {
          writeLiveUsage(usageCacheKey, next);
        }
        setUsageRead({ scope: usageScope, usage: next, loading: false });
      }, () => {
        if (!active || controller.signal.aborted) return;
        setUsageRead(previous => previous?.scope === usageScope ? { ...previous, loading: false } : previous);
      }).finally(() => { if (pending === controller) pending = undefined; });
    };
    refreshUsageRef.current = refreshUsage;
    refreshUsage();
    return () => {
      active = false;
      pending?.abort();
      if (refreshUsageRef.current === refreshUsage) refreshUsageRef.current = () => undefined;
    };
  }, [usageScope, usageScopeKey, hasUsageLoader]);
  // Catalog and quota reads start together on open; only quota polls while the list stays open.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    // Catalog membership changes less often than quota, but the same open refreshes both.
    // Closing or switching scope aborts the catalog; quota keeps its own scope lifetime.
    void refreshCatalogRef.current?.(controller.signal);
    if (!hasUsageLoader) return () => controller.abort();
    refreshUsageRef.current();
    const interval = window.setInterval(() => refreshUsageRef.current(), 30_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [open, usageScope, hasUsageLoader]);
  /** What every opening starts from: no search, the provider in force, the highlight on the current model. */
  const startOpen = () => { setQuery(''); setPreviewProviderId(activeProviderId); setOpenCycle((cycle) => cycle + 1); };
  // A host that opens the menu itself starts it the same way.
  const openedByHost = controlled && openProp;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (openedByHost) startOpen(); }, [openedByHost]);
  // Opening the list, or switching provider for real, starts on the provider in force.
  useEffect(() => {
    if (open) setPreviewProviderId(activeProviderId);
  }, [open, activeProviderId]);
  const current = models.find((model) => model.id === value);
  const label = current?.label ?? (value || shownPlaceholder);
  const catalogError = error?.trim();
  const failure = catalogError ? `Couldn't load models: ${catalogError}` : undefined;
  // Stays the retry while that retry runs, so the focused trigger is not disabled out from under it.
  // The Agent menu always opens so even an empty list can be rechecked.
  const retryOnly = !models.length && !failure && Boolean(onRetry) && !picksAgent && !agentColumn;
  const retryHeld = retryOnly && (loading || refreshing);
  const waited = useLingering(loading, WAIT_GRACE_MS);
  const retryTitle = retryOnly && !loading ? failure ?? 'No models available' : undefined;
  const tags = selectionTags(params);
  const selectedEffort = params.find((param) => paramKind(param) === 'effort')?.value;
  const sorted = useMemo(() => [...params].sort((a, b) => kindOrder[paramKind(a)] - kindOrder[paramKind(b)]), [params]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Beside several agents a search looks through every list the column holds, each run filed
    // under its agent and provider, so a model is found without knowing who offers it.
    if (needle && agentColumn && providers) {
      return providers.flatMap((provider) => provider.models
        .filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(needle))
        .map((model) => ({ ...model, group: sourceTitle(provider, providers) })));
    }
    const source = selectableModels ?? [];
    return needle ? source.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(needle)) : source;
  }, [selectableModels, query, agentColumn, providers]);
  /** Runs of one provider, in list order, so each heading can name its group for a screen reader. */
  const sections = useMemo(() => {
    const runs: Array<{ group?: string; start: number; models: Choice[] }> = [];
    // Beside the columns the list is one provider's, which the column already names; only a search across them is filed by group.
    const headed = !providerColumn || Boolean(query.trim());
    filtered.forEach((model, index) => {
      const group = headed ? model.group ?? providerLabel : undefined;
      const last = runs.at(-1);
      if (last && last.group === group) last.models.push(model);
      else runs.push({ group, start: index, models: [model] });
    });
    return runs;
  }, [filtered, providerLabel, providerColumn, query]);
  /*
   * The search field keeps focus while ↑/↓ move the active row and Enter picks it — the combobox the
   * composer's own `/` and `@` menus use (`aria-activedescendant`). A fresh list starts on the current
   * model, a search on its first match.
   */
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const activeTargetId = previewIsActive ? value : previewProvider?.rememberedModelId;
  const currentIndex = useMemo(
    () => (query.trim() || !activeTargetId ? -1 : filtered.findIndex((model) => model.id === activeTargetId)),
    [filtered, query, activeTargetId],
  );
  // Only an opening, a provider switch or a new search moves highlight back to the default slot;
  // a catalog or usage re-render under the reader's arrow keys or pointer must leave it alone.
  const highlightKey = `${openCycle}|${previewProvider?.id ?? ''}|${query}`;
  const [highlightState, setHighlightState] = useState<{ key: string; index: number }>({ key: '', index: -1 });
  const manualHighlight = highlightState.key === highlightKey;
  const highlight = manualHighlight ? highlightState.index : Math.max(0, currentIndex);
  const active = Math.min(highlight, Math.max(0, filtered.length - 1));
  const setHighlight = (index: number) => setHighlightState({ key: highlightKey, index });
  const choose = (model: Choice) => {
    // Reopening the current model to adjust effort must not reset its other parameters.
    if (model.id !== value) onChange(model.id);
    if (inlineParams || !onParamChange) setOpen(false); else setQuery('');
  };

  const paramRows = onParamChange ? sorted.map((param) => <ParamControl key={param.id} param={param} disabled={disabled} mobile={isMobile} onChange={(next) => onParamChange(param.id, next)} />) : [];
  const controls = inlineParams && paramRows.length > 0 ? <div className="flex shrink-0 flex-col gap-3">{paramRows}</div> : null;
  /*
   * The account's quota is the last row under the parameters, in their row shape: it describes the
   * provider in force as they do. "All models" is what a model's own quota tag cannot say — every
   * model draws on these windows, and a tagged model on its own cap besides. A refresh dims the
   * figures in place, so the row neither shifts nor empties every 30 seconds.
   */
  const accountRow = usageFigures.length > 0 || (usageLoading && !usage) ? (
    <div aria-busy={usageLoading || undefined} className="flex min-h-6 items-center gap-3">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-fg-2">Quota left</span>
        <span className="truncate text-2xs text-fg-3">All models</span>
      </span>
      <span className={cn('flex shrink-0 items-center gap-2.5 text-xs tabular-nums transition-opacity', usageLoading && usageFigures.length > 0 && 'opacity-60')}>
        {usageFigures.map((figure, index) => (
          <span key={`${figure.name ?? ''}:${index}`} title={figure.hint} className={figureToneClass[figure.tone]}>
            {figure.name && <span className={cn('mr-1', figure.tone === 'muted' && 'text-fg-4')}>{figure.name}</span>}
            {figure.value}{figure.reset && ` · ${figure.reset}`}
          </span>
        ))}
        {!usageFigures.length && <Spinner className="size-3 text-fg-4" />}
      </span>
    </div>
  ) : null;
  const settingsRows = previewIsActive && !inlineParams ? paramRows : [];

  const searchHeader = (
    <div className="flex h-11 shrink-0 items-center gap-2 edge-b px-3 md:h-9">
      <IconSearch className="size-3.5 shrink-0 text-fg-4" />
      <input
        ref={searchRef}
        autoFocus={!isMobile && window.matchMedia('(hover: hover)').matches}
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-4"
        aria-label="Search models"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={filtered.length ? optionId(active) : undefined}
        placeholder="Search models"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (isComposingKey(event.nativeEvent) || !filtered.length) return;
          const count = filtered.length;
          if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((active + 1) % count); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((active - 1 + count) % count); }
          else if (event.key === 'Enter' && !disabled) { event.preventDefault(); choose(filtered[active]!); }
        }}
      />
    </div>
  );

  const modelList = (
    // Beside the providers the list starts at the height every provider fits in, then takes up
    // whatever the locked popover leaves it (see `lockedHeight`).
    <div ref={listRef} id={listId} role="listbox" aria-label="Models" style={providerColumn ? { flexBasis: providerListHeight } : undefined} className={cn('relative min-h-0 overflow-y-auto overscroll-contain p-1', providerColumn ? 'shrink grow' : 'max-h-64')}>
      {/* Sections come from the *rendered* rows, so a search that filters a group down to
          nothing never leaves its heading behind. */}
      {sections.map((section) => (
        <div key={`${section.start}:${section.group ?? ''}`} role={section.group ? 'group' : undefined} aria-label={section.group}>
          {section.group && <div aria-hidden title={section.group} className={cn('truncate px-2 pb-1 text-xs font-medium text-fg-3', section.start ? 'pt-2.5' : 'pt-1')}>{section.group}</div>}
          {section.models.map((model, offset) => {
            const index = section.start + offset;
            return (
              <button
                key={model.id}
                id={optionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={model.id === value}
                onPointerMove={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(model)}
                disabled={disabled}
                className={cn('flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors disabled:opacity-50 md:h-8 md:min-h-0', index === active && 'bg-hover', model.id === value ? 'text-fg' : 'text-fg-2')}
              >
                <span className="min-w-0 flex-1 truncate">{model.label}</span>
                {previewIsActive && <ModelStatusTags status={modelUsageStatus(usage, model, activeProviderId, selectedEffort, model.id === value)} />}
                {model.id === value && <IconCheck className="size-3.5 shrink-0 text-fg-2" />}
              </button>
            );
          })}
        </div>
      ))}
      {/* Another agent that lists nothing offers only its default model; why it lists nothing stays readable under it. */}
      {agentColumn && !previewIsActive && !query.trim() && filtered.length > 0 && previewProvider?.issue && (
        <div role="note" className="break-words px-2 pb-1 pt-2 text-xs text-fg-3">{previewProvider.issue}</div>
      )}
      {!filtered.length && (
        <div className="px-2 py-6 text-center text-sm text-fg-3">
          {query.trim() ? 'No matching models'
            : providerColumn && previewProvider?.loading ? 'Loading…'
              : providerColumn && previewProvider?.issue ? <span className="break-words">{previewProvider.issue}</span>
                : 'No models available'}
        </div>
      )}
    </div>
  );

  // Looking around another provider stays a preview unless `onSelectProvider` opts into instant
  // switching (used by new-session pickers where each provider's last model is remembered).
  const preview = (provider: ModelProviderChoices) => {
    setPreviewProviderId(provider.id);
    setQuery('');
    setHighlightState({ key: '', index: -1 });
    if (provider.id !== activeProvider?.id) onPreviewProvider?.(provider.id);
    searchRef.current?.focus({ preventScroll: true });
  };
  const columnClass = 'relative flex shrink-0 flex-col gap-0.5 overflow-y-auto overscroll-contain edge-r p-1 [contain:size]';
  const rowClass = (shown: boolean, muted?: boolean) => cn('flex min-h-11 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors md:h-8 md:min-h-0 [&_svg]:shrink-0', shown ? 'bg-hover text-fg' : 'text-fg-2', muted && !shown && 'text-fg-4');
  const unusable = (provider: ModelProviderChoices) => Boolean(provider.issue) && !provider.models.length;
  const selectProvider = (provider: ModelProviderChoices) => {
    preview(provider);
    if (onSelectProvider && provider.id !== activeProvider?.id && !unusable(provider)) onSelectProvider(provider.id);
  };
  const previewGroup = groups.find((group) => group.agent.id === previewProvider?.agent?.id);
  const activeAgentId = activeProvider?.agent?.id;
  /** An agent opens on the provider in force, else its saved default, else its first. */
  const selectAgent = (group: (typeof groups)[number]) => {
    if (group.agent.id === activeAgentId) {
      preview(group.providers.find((provider) => provider.id === activeProvider?.id) ?? group.providers.find((provider) => provider.preferred) ?? group.providers[0]!);
      return;
    }
    const target = group.providers.find((provider) => provider.preferred && !unusable(provider))
      ?? group.providers.find((provider) => !unusable(provider))
      ?? group.providers.find((provider) => provider.preferred)
      ?? group.providers[0]!;
    selectProvider(target);
  };
  const providerList = !providerColumn ? null : agentColumn ? (
    <>
      <div ref={agentsRef} role="listbox" aria-label="Agents" className={cn(columnClass, 'w-44')}>
        {groups.map((group) => (
          <button
            key={group.agent.id}
            type="button"
            role="option"
            aria-selected={group.agent.id === activeAgentId}
            onClick={() => selectAgent(group)}
            className={rowClass(group.agent.id === previewGroup?.agent.id, group.providers.every(unusable))}
          >
            {group.agent.icon}
            <span className="min-w-0 flex-1 truncate">{group.agent.label}</span>
            {!providerTier && group.providers.some((provider) => provider.loading) && <Spinner />}
            {group.agent.id === activeAgentId && <IconCheck className="size-3.5 shrink-0 text-fg-2" />}
          </button>
        ))}
      </div>
      {providerTier && (
        <div ref={providersRef} role="listbox" aria-label="Providers" className={cn(columnClass, 'w-40')}>
          {previewGroup?.providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              role="option"
              aria-selected={provider.id === activeProvider?.id}
              data-preview={provider.id === previewProvider?.id || undefined}
              onClick={() => selectProvider(provider)}
              className={rowClass(provider.id === previewProvider?.id, unusable(provider))}
            >
              <span className="min-w-0 flex-1 truncate">{provider.label}</span>
              {provider.loading && <Spinner />}
              {provider.id === activeProvider?.id && <IconCheck className="size-3.5 shrink-0 text-fg-2" />}
            </button>
          ))}
        </div>
      )}
    </>
  ) : (
    <div ref={providersRef} role="listbox" aria-label="Providers" className={cn(columnClass, 'w-32')}>
      {providers!.map((provider) => (
        <button
          key={provider.id}
          type="button"
          role="option"
          aria-selected={provider.id === activeProvider?.id}
          data-preview={provider.id === previewProvider?.id || undefined}
          onClick={() => selectProvider(provider)}
          className={rowClass(provider.id === previewProvider?.id)}
        >
          <span className="min-w-0 flex-1 truncate">{provider.label}</span>
          {provider.loading && <Spinner />}
          {provider.id === activeProvider?.id && <IconCheck className="size-3.5 shrink-0 text-fg-2" />}
        </button>
      ))}
    </div>
  );

  /*
   * The popover opens above its trigger, so any change in its height moves its top edge — and the
   * provider row under the pointer with it. Its height is read once it opens and held until it
   * closes: previewing another provider (which hides the parameters and the quota row) or a
   * parameter that adds a row only resizes the model list inside it. When opening below (`side ===
   * 'bottom'`), `minHeight` holds the floor across provider previews while still letting async
   * parameters and quota expand the popover down to `max-h` instead of squeezing the lists.
   */
  const [lockedHeight, setLockedHeight] = useState<number>();
  const footerCount = settingsRows.length + (previewIsActive && accountRow ? 1 : 0);
  useEffect(() => {
    if (!open || !providerColumn) { setLockedHeight(undefined); return; }
    if (side === 'top' && loading) return;
    // The portal mounts its content a render after `open`, so the content is read on the next
    // frame, found through the list it holds; the frame painted before it is the same height.
    const frame = requestAnimationFrame(() => {
      const height = document.getElementById(listId)?.closest<HTMLElement>('.ui-popover-content')?.offsetHeight;
      if (height) setLockedHeight((previous) => (previewIsActive ? Math.max(previous ?? 0, height) : previous ?? height));
    });
    return () => cancelAnimationFrame(frame);
  }, [open, providerColumn, listId, side, loading, previewIsActive, footerCount]);

  // On mobile the sheet needs its own scroll lock; on desktop let Popover inherit modal state when inside a Dialog.
  const picker = (
    <Popover modal={isMobile || undefined} open={open} onOpenChange={(next) => { if (next) startOpen(); setOpen(next); }}>
      <PopoverTrigger
        data-model-picker
        aria-label={retryOnly ? t`重新加载模型列表` : t({ message: '选择模型', context: 'session-model-picker-label' })}
        aria-description={retryTitle ?? failure}
        aria-busy={loading || undefined}
        title={retryTitle ?? failure}
        disabled={disabled || (!models.length && !retryOnly && !failure && !picksAgent && !agentColumn)}
        // With nothing to list the trigger opens no popup.
        {...(retryOnly ? { 'aria-haspopup': undefined, 'aria-expanded': undefined, 'aria-controls': undefined, 'aria-disabled': retryHeld || undefined } : {})}
        // Radix skips its toggle for a prevented click, so an empty list is read again instead of opened.
        onClick={retryOnly ? (event) => { event.preventDefault(); if (!retryHeld) onRetry?.(); } : undefined}
        className={cn('group/model inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-sm text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg', inlineParams && mobilePickerTriggerClass, !models.length && failure && 'text-danger hover:text-danger', retryHeld && 'opacity-60 hover:bg-transparent', className)}
      >
        {leading}
        <span className={cn('max-w-32 truncate sm:max-w-44', inlineParams && 'min-w-0 flex-1 max-w-none text-left sm:max-w-none', labelClassName)}>{label}</span>
        {tags.effort && <span className="shrink-0 text-xs text-fg-3 transition-colors group-hover/model:text-fg-2">{tags.effort}</span>}
        {/* Parameters read as words in the effort's own style: a glyph or chip apiece was noise. */}
        {tags.fast && <span className="shrink-0 text-xs text-fg-3 transition-colors group-hover/model:text-fg-2">Fast</span>}
        {tags.max && <span className="shrink-0 text-xs text-fg-3 transition-colors group-hover/model:text-fg-2">MAX</span>}
        {tags.context && <span className="shrink-0 text-xs text-fg-3 transition-colors group-hover/model:text-fg-2">{tags.context}</span>}
        {failure && <StatusDot tone="warning" />}
        {loading ? waited && <Spinner className="size-3 shrink-0 text-fg-4" /> : retryOnly ? <IconRotateCw aria-hidden className="size-3 shrink-0" /> : null}
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        tabIndex={-1}
        side={side}
        align={align}
        // Opening rightwards from the agent's mark, the agent column's marks sit under it: the
        // trigger insets its mark 10px, the column's rows 12 (4 of list padding, 8 of row).
        alignOffset={agentColumn && align === 'start' ? -2 : 0}
        onOpenAutoFocus={(event) => {
          if (!isMobile) return;
          event.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
        style={lockedHeight ? (side === 'bottom' ? { minHeight: `min(${lockedHeight}px, 64dvh, var(--radix-popover-content-available-height, 64dvh))` } : { height: `min(${lockedHeight}px, var(--radix-popover-content-available-height, ${lockedHeight}px))` }) : undefined}
        className={cn('flex max-h-[min(64dvh,420px,var(--radix-popover-content-available-height,420px))] flex-col', agentColumn ? providerTier ? 'w-[min(660px,calc(100vw-24px))]' : 'w-[min(500px,calc(100vw-24px))]' : providerColumn ? 'w-[min(440px,calc(100vw-24px))]' : loadUsage ? 'w-[min(360px,calc(100vw-24px))]' : 'w-[min(300px,calc(100vw-24px))]')}
      >
        {sourceLabel && (
          <div className="flex shrink-0 items-center gap-1.5 edge-b bg-subtle/40 px-3 py-1.5 text-2xs text-fg-3">
            <IconServer className="size-3 shrink-0 text-fg-4" />
            <span className="truncate">{sourceLabel}</span>
          </div>
        )}
        {/* The failure is the active agent's; another one previewed brings its own note in the list. */}
        {failure && previewIsActive && (
          <div role="status" className="flex shrink-0 items-center gap-2 edge-b px-3 py-1.5 text-2xs text-fg-3">
            <span className="max-h-24 min-w-0 flex-1 overflow-y-auto break-words">{failure}</span>
            {onRetry && <Button size="xs" variant="quiet" className="-my-1 shrink-0" disabled={loading || refreshing} onClick={onRetry}>Retry</Button>}
          </div>
        )}
        {providerColumn ? (
          <div className="flex min-h-0 flex-1">
            {providerList}
            <div className="flex min-w-0 flex-1 flex-col">
              {searchHeader}
              {modelList}
            </div>
          </div>
        ) : (
          <>
            {searchHeader}
            {modelList}
          </>
        )}
        {/* Both describe the provider in force and go while another is previewed; what comes and
            goes at the bottom moves nothing above it. */}
        {(settingsRows.length > 0 || (previewIsActive && accountRow)) && (
          <div className="flex shrink-0 flex-col gap-3 edge-t bg-subtle/60 px-3 py-3">
            {settingsRows}
            {previewIsActive && accountRow}
          </div>
        )}
        {/* Mounted after the listboxes so their refs are attached before this layout effect runs. */}
        <PickerScrollSync
          listRef={listRef}
          agentsRef={agentsRef}
          providersRef={providersRef}
          activeOptionId={filtered.length ? optionId(active) : undefined}
          revealKey={`${openCycle}|${previewProvider?.id ?? ''}|${query.trim() ? 'q' : ''}`}
          columnKey={`${openCycle}|${previewGroup?.agent.id ?? ''}`}
          layoutKey={`${footerCount}|${previewIsActive ? 1 : 0}`}
          hasCurrent={currentIndex >= 0}
          manual={manualHighlight}
        />
      </PopoverContent>
    </Popover>
  );
  return inlineParams ? <div className="flex w-full min-w-0 flex-col gap-3">{picker}{controls}</div> : picker;
}
