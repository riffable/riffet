import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { ModelStatus, NativeBackendUsage } from '@contracts';
import { IconCheck, IconChevronDown, IconRotateCw, IconSearch } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch, Spinner, StatusDot } from '@/components/ui/controls';
import { contextChoices, isOn, optionLabel, paramHint, paramKind, paramTitle, toggledValue, type ModelParam, type ParamKind } from '@/lib/models';
import { cn } from '@/lib/utils';
import { accountSummary, loadHint, loadTone, statusQuotaTags } from '@/lib/usage';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import type { Choice } from './model';
import { isComposingKey } from './composerKeyboard';
import { useLingering, WAIT_GRACE_MS } from './sessionLayout';

const kindOrder: Record<ParamKind, number> = { effort: 0, toggle: 1, select: 2, fast: 3, max: 4 };
const mobilePickerTriggerClass = 'inline-flex h-11 w-full min-w-0 items-center justify-between gap-1.5 rounded-xl border border-line-strong bg-bg px-3 text-base text-fg-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg';
/**
 * The same control on a pointer device. It is one row tall and sits at the end of the row, exactly
 * like the switches beside it: a labelled box on its own line made the Effort parameter look like a
 * different kind of setting from Thinking, Fast and Max, which are three rows of the same height.
 */
const desktopPickerTriggerClass = 'inline-flex h-6 min-w-0 items-center justify-between gap-1 rounded-md border border-line-strong bg-bg px-2 text-xs text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg';

function SlidingSegments({ param, onChange, disabled, options = param.options, value = param.value, label }: { param: ModelParam; onChange: (value: string) => void; disabled?: boolean; options?: ModelParam['options']; value?: string; label?: string }) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const count = options.length;
  return (
    <div role="radiogroup" aria-label={label ?? paramTitle(param)} className="relative grid rounded-lg bg-muted p-0.5" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-md bg-elevated ring-[0.5px] ring-line-strong shadow-xs transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)]"
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
      {kind === 'fast' && param.options.some(option => option.value === 'default') && (
        <button type="button" disabled={disabled} aria-pressed={param.value === 'default'} onClick={() => onChange('default')} className={cn('rounded px-1 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus', param.value === 'default' ? 'text-accent' : 'text-fg-3')}>Default</button>
      )}
      <Switch checked={on} disabled={disabled} onCheckedChange={(checked) => onChange(toggledValue(param, checked))} aria-label={paramTitle(param)} aria-description={param.value === 'default' ? 'Follows the default' : undefined} />
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

/** The last figures read per usage scope, shown again while the next open re-reads them. */
const lastUsage = new Map<string, NativeBackendUsage>();
const LAST_USAGE_LIMIT = 32;

const loadToneClass = { danger: 'text-danger', warning: 'text-warning', muted: 'text-fg-4' } as const;

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
}

export function ModelPicker({ models, value, params = [], onChange, onParamChange, disabled, side = 'top', align = 'start', placeholder, className, inlineParams = false, loadUsage, refreshCatalog, usageScopeKey, providers, activeProviderId, providerLabel, loading = false, refreshing = false, error, onRetry }: {
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
  /** `end` where the trigger closes a right-aligned row, so the open list stays put as its tags change width. */
  align?: 'start' | 'end';
  className?: string;
  /** Show parameters below the trigger in a settings sheet, outside the model list. */
  inlineParams?: boolean;
  /** Reads account quota and per-model load, keyed by choice id, each time the list opens. */
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
}) {
  const { t } = useLingui();
  const shownPlaceholder = placeholder ?? 'Default model';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const usageScope = `${usageScopeKey ?? ''}|${activeProviderId ?? ''}`;
  const [usageRead, setUsageRead] = useState<{ scope: string; usage: NativeBackendUsage }>();
  // A scope read before keeps its figures while this open re-reads them, so the account row is
  // there from the first frame rather than pushing the search and the list down when it lands.
  const usage = usageRead?.scope === usageScope ? usageRead.usage : usageScopeKey ? lastUsage.get(usageScope) : undefined;
  const loadUsageRef = useRef(loadUsage);
  loadUsageRef.current = loadUsage;
  const refreshCatalogRef = useRef(refreshCatalog);
  // Opening a failed catalog reveals its diagnostic; retry is an explicit action inside it.
  refreshCatalogRef.current = error?.trim() ? undefined : refreshCatalog;
  // A provider column needs the width of a pointer device's popover; a phone sheet keeps the one
  // grouped list, whose headings already say which provider each run of models came from.
  const providerColumn = !isMobile && (providers?.length ?? 0) > 1;
  const [previewProviderId, setPreviewProviderId] = useState(activeProviderId);
  const previewProvider = providers?.find((provider) => provider.id === previewProviderId) ?? providers?.[0];
  const activeProvider = providers?.find((provider) => provider.id === activeProviderId) ?? providers?.[0];
  /** Whether the listed provider is the one in force; parameters and quota only describe that one. */
  const previewIsActive = !providerColumn || previewProvider?.id === activeProvider?.id;
  const selectableModels = providerColumn ? previewProvider?.models : models;
  /*
   * Beside the providers the list is as tall as the longest provider's needs (or the provider
   * column's), so moving between providers never resizes it; a short provider leaves room only
   * when another one needs it. A loading or empty provider shows a one-line note in the same space.
   */
  const providerListHeight = useMemo(() => {
    if (!providerColumn || !providers) return 0;
    const column = 8 + providers.length * 34 - 2;
    const lists = providers.map((provider) => provider.models.length ? modelListHeight(provider.models, providerLabel) : 72);
    return Math.min(MODEL_LIST_MAX, Math.max(column, ...lists));
  }, [providerColumn, providers, providerLabel]);
  // Load and quota move by the minute, so they are read when the list opens rather than kept with
  // the catalog. A failed read leaves the figures out; the list itself never waits for it.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    // Catalog membership changes less often than quota, but it must not be the stale half of an
    // open: the same open reads both, and a closed or provider-switched menu drops either answer.
    void refreshCatalogRef.current?.(controller.signal);
    // Quota belongs to the provider in force: figures are kept per scope, so a switch is never mislabelled.
    const load = loadUsageRef.current;
    if (!load) return () => controller.abort();
    load(controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      if (usageScopeKey) {
        lastUsage.delete(usageScope);
        lastUsage.set(usageScope, next);
        if (lastUsage.size > LAST_USAGE_LIMIT) lastUsage.delete(lastUsage.keys().next().value!);
      }
      setUsageRead({ scope: usageScope, usage: next });
    }, () => {
      if (controller.signal.aborted) return;
      lastUsage.delete(usageScope);
      setUsageRead(undefined);
    });
    return () => controller.abort();
  }, [open, activeProviderId, usageScopeKey]);
  // Opening the list, or switching provider for real, starts on the provider in force.
  useEffect(() => {
    if (open) setPreviewProviderId(activeProviderId);
  }, [open, activeProviderId]);
  const current = models.find((model) => model.id === value);
  const label = current?.label ?? (value || shownPlaceholder);
  const catalogError = error?.trim();
  const failure = catalogError ? `Couldn't load models: ${catalogError}` : undefined;
  // Stays the retry while that retry runs, so the focused trigger is not disabled out from under it.
  const retryOnly = !models.length && !failure && Boolean(onRetry);
  const retryHeld = retryOnly && (loading || refreshing);
  const waited = useLingering(loading, WAIT_GRACE_MS);
  const retryTitle = retryOnly && !loading ? failure ?? 'No models available' : undefined;
  const tags = selectionTags(params);
  const sorted = useMemo(() => [...params].sort((a, b) => kindOrder[paramKind(a)] - kindOrder[paramKind(b)]), [params]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const source = selectableModels ?? [];
    return needle ? source.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(needle)) : source;
  }, [selectableModels, query]);
  /** Runs of one provider, in list order, so each heading can name its group for a screen reader. */
  const sections = useMemo(() => {
    const runs: Array<{ group?: string; start: number; models: Choice[] }> = [];
    filtered.forEach((model, index) => {
      const group = model.group ?? providerLabel;
      const last = runs.at(-1);
      if (last && last.group === group) last.models.push(model);
      else runs.push({ group, start: index, models: [model] });
    });
    return runs;
  }, [filtered, providerLabel]);
  /*
   * The search field keeps focus while ↑/↓ move the active row and Enter picks it — the combobox the
   * composer's own `/` and `@` menus use (`aria-activedescendant`). A fresh list starts on the current
   * model, a search on its first match.
   */
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const [highlight, setHighlight] = useState(0);
  const active = Math.min(highlight, Math.max(0, filtered.length - 1));
  useEffect(() => {
    if (!open) return;
    const current = query.trim() ? -1 : filtered.findIndex((model) => model.id === value);
    setHighlight(Math.max(0, current));
    // Only an opening or a new search moves it; a list re-rendered under the reader's arrow keys must not.
  }, [open, query]);
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  const choose = (model: Choice) => {
    // Reopening the current model to adjust effort must not reset its other parameters.
    if (model.id !== value) onChange(model.id);
    if (inlineParams || !onParamChange) setOpen(false); else setQuery('');
  };

  const controls = onParamChange && sorted.length > 0 ? (
    <div className={cn('flex shrink-0 flex-col gap-3', !inlineParams && 'edge-t bg-subtle/60 px-3 py-3')}>
      {sorted.map((param) => <ParamControl key={param.id} param={param} disabled={disabled} mobile={isMobile} onChange={(next) => onParamChange(param.id, next)} />)}
    </div>
  ) : null;

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
    <div id={listId} role="listbox" aria-label="Models" style={providerColumn ? { flexBasis: providerListHeight } : undefined} className={cn('min-h-0 overflow-y-auto overscroll-contain p-1', providerColumn ? 'shrink grow' : 'max-h-64')}>
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
                {previewIsActive && <ModelStatusTags status={usage?.models[model.id]} />}
                {model.id === value && <IconCheck className="size-3.5 shrink-0 text-fg-2" />}
              </button>
            );
          })}
        </div>
      ))}
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

  // The providers of the agent being started, beside their models. A click only previews one:
  // picking a model is what commits that provider, so looking around never resets a setting.
  const providerList = providerColumn ? (
    <div role="listbox" aria-label="Providers" className="flex w-32 shrink-0 flex-col gap-0.5 overflow-y-auto overscroll-contain edge-r p-1 [contain:size]">
      {providers!.map((provider) => (
        <button
          key={provider.id}
          type="button"
          role="option"
          aria-selected={provider.id === activeProvider?.id}
          onClick={() => { setPreviewProviderId(provider.id); setQuery(''); searchRef.current?.focus({ preventScroll: true }); }}
          className={cn('flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors md:h-8 md:min-h-0', provider.id === previewProvider?.id ? 'bg-hover text-fg' : 'text-fg-2')}
        >
          <span className="min-w-0 flex-1 truncate">{provider.label}</span>
          {provider.loading && <Spinner />}
          {provider.id === activeProvider?.id && <IconCheck className="size-3.5 shrink-0 text-fg-2" />}
        </button>
      ))}
    </div>
  ) : null;

  /*
   * The popover opens above its trigger, so any change in its height moves its top edge — and the
   * provider row under the pointer with it. Its height is read once it opens and held until it
   * closes: previewing another provider (which hides the parameters and the quota row) or a
   * parameter that adds a row only resizes the model list inside it.
   */
  const [lockedHeight, setLockedHeight] = useState<number>();
  useEffect(() => {
    if (!open || !providerColumn) { setLockedHeight(undefined); return; }
    // The portal mounts its content a render after `open`, so the content is read on the next
    // frame, found through the list it holds; the frame painted before it is the same height.
    const frame = requestAnimationFrame(() => {
      const height = document.getElementById(listId)?.closest<HTMLElement>('.ui-popover-content')?.offsetHeight;
      if (height) setLockedHeight(height);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, providerColumn, listId]);

  // A mobile settings dialog isolates scrolling; the portalled model list needs its own scope.
  const picker = (
    <Popover modal={isMobile} open={open} onOpenChange={(next) => { if (next) { setQuery(''); setPreviewProviderId(activeProviderId); } setOpen(next); }}>
      <PopoverTrigger
        data-model-picker
        aria-label={retryOnly ? t`重新加载模型列表` : t({ message: '选择模型', context: 'session-model-picker-label' })}
        aria-description={retryTitle ?? failure}
        aria-busy={loading || undefined}
        title={retryTitle ?? failure}
        disabled={disabled || (!models.length && !retryOnly && !failure)}
        // With nothing to list the trigger opens no popup.
        {...(retryOnly ? { 'aria-haspopup': undefined, 'aria-expanded': undefined, 'aria-controls': undefined, 'aria-disabled': retryHeld || undefined } : {})}
        // Radix skips its toggle for a prevented click, so an empty list is read again instead of opened.
        onClick={retryOnly ? (event) => { event.preventDefault(); if (!retryHeld) onRetry?.(); } : undefined}
        className={cn('group/model inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-sm text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg', inlineParams && mobilePickerTriggerClass, !models.length && failure && 'text-danger hover:text-danger', retryHeld && 'opacity-60 hover:bg-transparent', className)}
      >
        <span className={cn('max-w-32 truncate sm:max-w-44', inlineParams && 'min-w-0 flex-1 max-w-none text-left sm:max-w-none')}>{label}</span>
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
        onOpenAutoFocus={(event) => {
          if (!isMobile) return;
          event.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
        style={lockedHeight ? { height: lockedHeight } : undefined}
        className={cn('flex max-h-[min(64dvh,420px)] flex-col', providerColumn ? 'w-[min(440px,calc(100vw-24px))]' : loadUsage ? 'w-[min(360px,calc(100vw-24px))]' : 'w-[min(300px,calc(100vw-24px))]')}
      >
        {failure && (
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
        {!inlineParams && previewIsActive && controls}
        {/* Below the list with the parameters: both describe the provider in force and go while
            another is previewed, and what comes and goes at the bottom moves nothing above it. */}
        {usage?.account && previewIsActive && (
          <div className={cn('shrink-0 edge-t px-3 py-1.5 text-2xs tabular-nums', usage.account.limitReached ? 'text-danger' : 'text-fg-3')}>
            {usage.account.limitReached && 'Usage limit reached · '}{accountSummary(usage.account)}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
  return inlineParams ? <div className="flex w-full min-w-0 flex-col gap-3">{picker}{controls}</div> : picker;
}
