/*
 * Card JSON 2.0 for what the core renders: the turn card, the interaction card, the project picker
 * and the plain notice. Pure functions from a view to JSON; sending, throttling and degrading on
 * errors live in surface.ts.
 *
 * `standard_icon` tokens are limited to ones confirmed in Feishu's official list: an unknown token
 * in a header or button fails the whole card (200621), and no icon is better than a guess.
 */
import type { CommandPanelView, InteractionView, ModelPickerView, PanelView, ProjectPickerView, TurnView } from '@riffet/plugin-api';
import { renderMarkdown, type CardElement, type TableMode } from './markdown.js';
import { HERO, SUB, STRONG, buttonRow, callbackValue, card as kitCard, commandGroup, md, note, oneLine, plain, safe, select, selectBlock, simpleCard, surface, type Card, type CallbackValue } from './kit.js';

export { callbackValue, type Card, type CallbackValue };

/** Feishu serializes a card against a ~30 KB ceiling; stay clear of it. */
export const CARD_SAFE_BYTES = 20_000;
export const MAX_TOP_LEVEL_ELEMENTS = 45;
export const MAX_TABLES_PER_CARD = 5;
const WINDOW_PREFIX_BYTES = 12_000;
const WINDOW_TAIL_CHARS = 2000;
const NAME_MAX = 100;

const ICON_LOADING = { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' };
const ICON_STOP = { tag: 'standard_icon', token: 'stop_outlined' };

const byteLength = (value: unknown): number => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const grey = note;

// ── Callback values ──

export function parseCallbackValue(value: unknown): CallbackValue | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { v, ref, action } = value as Record<string, unknown>;
  return v === 1 && typeof ref === 'string' && typeof action === 'string' ? { v: 1, ref, action } : undefined;
}
/** A form's submit button loses its `value`, so the route rides in `name` (at most 100 characters). */
export const FORM_SUBMIT_PREFIX = 'ri:';
export const formSubmitName = (ref: string): string => `${FORM_SUBMIT_PREFIX}${ref}`.slice(0, NAME_MAX);
export const FORM_FIELD_PICK = 'pick';
export const FORM_FIELD_OTHER = 'other';
export const ACTION_STOP = 'stop';
export const ACTION_ANSWER = 'answer';
export const ACTION_PICK = 'pick';

const callbackButton = (text: string, value: CallbackValue, extra: Record<string, unknown> = {}): CardElement => ({
  tag: 'button',
  text: plain(text),
  size: 'medium',
  behaviors: [{ type: 'callback', value }],
  ...extra,
});

const card = (elements: CardElement[], header?: { title: string }): Card => kitCard({ ...(header ? { title: header.title } : {}), elements });

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ── The answer, at the degrade level the surface has reached ──

/** `native`: real tables; `code-tables`: after a table-limit error; `single`: after an element-limit error; `window`: too long to send whole. */
export type AnswerMode = 'native' | 'code-tables' | 'single' | 'window';

/** Prefix cut once at a paragraph boundary, so it is identical on every later render. */
function stablePrefix(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= WINDOW_PREFIX_BYTES) return text;
  const head = bytes.subarray(0, WINDOW_PREFIX_BYTES).toString('utf8').replace(/�$/, '');
  const cut = head.lastIndexOf('\n\n');
  return cut > head.length / 2 ? head.slice(0, cut) : head;
}

export function answerElements(answer: string, mode: AnswerMode): CardElement[] {
  if (!answer.trim()) return [];
  if (mode === 'native') return renderMarkdown(answer);
  if (mode === 'code-tables') return renderMarkdown(answer, { tables: 'code' });
  if (mode === 'single') return renderMarkdown(answer, { single: true });
  if (byteLength(answer) <= WINDOW_PREFIX_BYTES + WINDOW_TAIL_CHARS * 3) return renderMarkdown(answer, { single: true });
  const prefix = stablePrefix(answer);
  const tailStart = Math.max(prefix.length, answer.length - WINDOW_TAIL_CHARS);
  const lineStart = answer.indexOf('\n', tailStart);
  const tail = answer.slice(lineStart >= 0 && lineStart - tailStart < 200 ? lineStart + 1 : tailStart);
  return [...renderMarkdown(prefix, { single: true }), grey('…'), ...renderMarkdown(tail, { single: true })];
}

// ── The turn card ──

const RUNNING = new Set<TurnView['status']>(['queued', 'running', 'waiting']);
const WAITING_TEXT: Partial<Record<TurnView['status'], string>> = { queued: '排队中', waiting: '等待确认' };

function promptBlock(view: TurnView): CardElement[] {
  if (view.source !== 'other-client' || !view.prompt?.trim()) return [];
  const quoted = view.prompt.trim().slice(0, 500).replace(/<(\/?)font/gi, '＜$1font').split('\n').map(line => `> ${line}`).join('\n');
  return [{ tag: 'markdown', content: `<font color='grey'>来自其他端</font>\n${quoted}` }];
}

const greyText = (text: string, align?: 'right'): CardElement => ({
  tag: 'markdown', content: `<font color='grey'>${text}</font>`, text_size: 'notation', ...(align ? { text_align: align } : {}),
});

/** Model on the left; changes, context use and elapsed time on the right. Either side may be absent. */
function footerElement(view: TurnView): CardElement | undefined {
  const { footer: shown } = view.card;
  const { footer } = view;
  const left = shown.model && footer.model ? oneLine([footer.model, ...(footer.modelMarks ?? [])].join(' · '), 120) : '';
  const right: string[] = [];
  if (shown.changes && footer.changes && (footer.changes.added || footer.changes.removed)) {
    right.push(`<font color='green'>+${footer.changes.added}</font> <font color='red'>−${footer.changes.removed}</font>`);
  }
  if (shown.context && footer.contextPercent !== undefined) right.push(`<font color='grey'>上下文 ${Math.round(footer.contextPercent)}%</font>`);
  if (shown.elapsed && footer.elapsedMs !== undefined) right.push(`<font color='grey'>${formatElapsed(footer.elapsedMs)}</font>`);
  const rightText = right.join("<font color='grey'> · </font>");
  if (!left && !rightText) return undefined;
  const rightElement: CardElement = { tag: 'markdown', content: rightText, text_size: 'notation', text_align: 'right' };
  const columns: CardElement[] = [];
  if (left) columns.push({ tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [greyText(left)] });
  if (rightText) columns.push({ tag: 'column', width: left ? 'auto' : 'weighted', ...(left ? {} : { weight: 1 }), vertical_align: 'center', elements: [rightElement] });
  return { tag: 'column_set', flex_mode: 'none', background_style: 'default', horizontal_spacing: 'default', columns };
}

function trailingElements(view: TurnView, hasContent: boolean): CardElement[] {
  if (RUNNING.has(view.status)) {
    const columns: CardElement[] = [{
      tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
      elements: [{ tag: 'button', text: plain(WAITING_TEXT[view.status] ?? '处理中'), type: 'text', disabled: true, icon: ICON_LOADING }],
    }];
    if (view.stopRef && view.card.stopButton) {
      columns.push({
        tag: 'column', width: 'auto', vertical_align: 'center',
        elements: [callbackButton('中断', callbackValue(view.stopRef, ACTION_STOP), { type: 'text', icon: ICON_STOP })],
      });
    }
    return [{ tag: 'hr' }, { tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'small', columns }];
  }
  const status = view.status === 'failed'
    ? [{ tag: 'markdown', content: `<font color='red'>${oneLine(view.error ? `失败：${view.error}` : '失败', 300)}</font>` }]
    : view.status === 'completed' ? [] : [grey('已中断')];
  const footer = footerElement(view);
  const body = [...status, ...(footer ? [footer] : [])];
  return body.length && (hasContent || status.length) ? [{ tag: 'hr' }, ...body] : body;
}

const headerOf = (view: TurnView) => view.card.header ? { title: oneLine(view.title, 60) || 'Riffet' } : undefined;

export function turnCard(view: TurnView, mode: AnswerMode = 'native', answerOverride?: string): Card {
  const content = [...promptBlock(view), ...answerElements(answerOverride ?? view.answer, mode)];
  return card([...content, ...trailingElements(view, content.length > 0)], headerOf(view));
}

const tableCount = (elements: CardElement[]): number => elements.filter(element => element.tag === 'table').length;

/** Cuts a string into pieces of at most `maxBytes` UTF-8 bytes, never inside a code point. */
function chunkLine(line: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = byteLength(char);
    if (bytes + size > maxBytes && current) { chunks.push(current); current = ''; bytes = 0; }
    current += char;
    bytes += size;
  }
  chunks.push(current);
  return chunks;
}

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * A markdown element too large for one card, cut at line boundaries (a line longer than a part is
 * cut into pieces); a fence open at a cut is closed there and reopened in the next part.
 */
function splitMarkdown(element: CardElement, maxBytes: number): CardElement[] {
  const content = String(element.content ?? '');
  if (byteLength(content) <= maxBytes) return [element];
  const parts: CardElement[] = [];
  let current: string[] = [];
  let size = 0;
  let fence: { open: string; mark: string } | undefined;
  const limit = maxBytes - 64;
  const flush = () => {
    if (!current.length) return;
    parts.push({ ...element, content: `${current.join('\n')}${fence ? `\n${fence.mark}` : ''}` });
    current = fence ? [fence.open] : [];
    size = fence ? byteLength(fence.open) + 1 : 0;
  };
  for (const line of content.split('\n')) {
    const room = Math.max(limit - (fence ? byteLength(fence.open) + byteLength(fence.mark) + 4 : 0), 64);
    for (const piece of byteLength(line) > room ? chunkLine(line, room) : [line]) {
      const cost = byteLength(piece) + 1;
      const reserve = fence ? byteLength(fence.mark) + 1 : 0;
      // A part that holds only the reopened fence line has nothing worth sending yet.
      const hasBody = current.length > (fence && current[0] === fence.open ? 1 : 0);
      if (size + cost + reserve > limit && hasBody) flush();
      current.push(piece);
      size += cost;
    }
    const match = FENCE_LINE.exec(line);
    if (match) {
      const mark = match[1]!;
      if (!fence) fence = { open: line, mark };
      else if (mark[0] === fence.mark[0] && mark.length >= fence.mark.length && line.trim() === mark) fence = undefined;
    }
  }
  if (current.length) parts.push({ ...element, content: current.join('\n') });
  return parts;
}

function splitTable(element: CardElement, maxBytes: number): CardElement[] {
  const rows = (element.rows as unknown[]) ?? [];
  if (byteLength(element) <= maxBytes || rows.length < 2) return [element];
  const half = Math.ceil(rows.length / 2);
  return [{ ...element, rows: rows.slice(0, half), page_size: Math.min(Math.max(half, 1), 100) }, { ...element, rows: rows.slice(half), page_size: Math.min(Math.max(rows.length - half, 1), 100) }]
    .flatMap(part => splitTable(part, maxBytes));
}

/**
 * The finished answer cut into as many cards as the limits need: at most five tables, 45 top-level
 * elements and a safe serialized size each. The first card carries the header and the prompt, the
 * last one the footer; the caller sends the first by editing the original message and the rest as replies.
 */
export function finalCards(view: TurnView, mode: AnswerMode = 'native'): Card[] {
  const lead = promptBlock(view);
  const trail = trailingElements(view, lead.length > 0 || view.answer.trim().length > 0);
  const header = headerOf(view);
  const answer = answerElements(view.answer, mode).flatMap(element =>
    element.tag === 'markdown' ? splitMarkdown(element, CARD_SAFE_BYTES / 2) : element.tag === 'table' ? splitTable(element, CARD_SAFE_BYTES / 2) : [element]);

  const groups: CardElement[][] = [[...lead]];
  let size = byteLength(header ?? {}) + byteLength(lead) + 400;
  for (const element of answer) {
    const current = groups[groups.length - 1]!;
    const cost = byteLength(element);
    if (current.length >= MAX_TOP_LEVEL_ELEMENTS - trail.length || tableCount(current) + (element.tag === 'table' ? 1 : 0) > MAX_TABLES_PER_CARD || size + cost > CARD_SAFE_BYTES - byteLength(trail)) {
      groups.push([]);
      size = 400;
    }
    groups[groups.length - 1]!.push(element);
    size += cost;
  }
  groups[groups.length - 1]!.push(...trail);
  return groups.map((elements, index) => card(elements, index === 0 ? header : undefined));
}

/** A card that says the content could not be shown, keeping the controls and footer. */
export function placeholderCard(view: TurnView): Card {
  return turnCard(view, 'single', '无法显示此内容');
}

// ── Notices ──

export const noticeCard = (markdown: string): Card => simpleCard(undefined, markdown, HERO);

// ── Interaction ──

const CLOSED_LABEL: Record<NonNullable<InteractionView['closed']>['outcome'], string> = {
  answered: '已回答',
  'answered-elsewhere': '已在其他端处理',
  expired: '已过期',
  cancelled: '已取消',
};

export function interactionCard(view: InteractionView): Card {
  const { interaction } = view;
  const count = interaction.questionCount && interaction.questionCount > 1 ? `${interaction.questionIndex ?? 1}/${interaction.questionCount}` : undefined;
  const title = oneLine(`${oneLine(interaction.title, 60) || 'Riffet'}${count ? ` ${count}` : ''}`, 70);

  if (view.closed) {
    return kitCard({ title, elements: [surface(HERO, [md(`**${safe(view.closed.label || CLOSED_LABEL[view.closed.outcome], 200)}**`)])] });
  }

  const hero: CardElement[] = [];
  if (interaction.message?.trim()) hero.push(...renderMarkdown(interaction.message.slice(0, 4000), { single: true }));

  const asksForAnswer = (interaction.kind === 'question' || interaction.kind === 'choice') && (interaction.options.length > 0 || interaction.allowOther);
  if (asksForAnswer) {
    const controls: CardElement[] = [];
    if (interaction.options.length > 0) {
      const selected = interaction.options.filter(option => option.selected).map(option => option.id);
      const options = interaction.options.map(option => ({ text: plain(oneLine(option.label, 100) || option.id), value: option.id }));
      controls.push(interaction.multiple
        ? { tag: 'multi_select_static', name: FORM_FIELD_PICK, width: 'fill', placeholder: plain('选择'), options, ...(selected.length ? { selected_values: selected } : {}) }
        : { tag: 'select_static', name: FORM_FIELD_PICK, width: 'fill', placeholder: plain('选择'), options, ...(selected[0] ? { initial_option: selected[0] } : {}) });
    }
    if (interaction.allowOther) {
      controls.push({
        tag: 'input', name: FORM_FIELD_OTHER, width: 'fill', placeholder: plain('其他'), max_length: 1000,
        ...(interaction.otherValue ? { default_value: interaction.otherValue.slice(0, 1000) } : {}),
      });
    }
    controls.push({ tag: 'button', text: plain('提交'), type: 'primary', name: formSubmitName(view.ref), form_action_type: 'submit' });
    // A form only works at the card's root, so the coloured block goes inside it, not around it.
    return kitCard({ title, elements: [{ tag: 'form', name: 'answer', elements: [surface(HERO, [...hero, ...controls])] }] });
  } else if (interaction.actions.length > 0) {
    hero.push(buttonRow(interaction.actions.slice(0, 6).map(action => ({
      text: action.label || action.id, value: callbackValue(view.ref, action.id), type: action.tone ?? 'default',
    }))));
  }
  if (!hero.length) hero.push(md('**等待回答**'));
  return kitCard({ title, elements: [surface(HERO, hero)] });
}

// ── Project picker ──

export function projectPickerCard(view: ProjectPickerView): Card {
  const title = '选择项目';
  const selected = view.projects.find(project => project.id === view.selectedId);
  if (view.closed) return kitCard({ title, elements: [surface(HERO, [md(`**${selected ? `已选择 ${safe(selected.name, 100)}` : '已选择'}**`)])] });
  const names = new Map<string, number>();
  for (const project of view.projects) names.set(project.name, (names.get(project.name) ?? 0) + 1);
  const label = (project: ProjectPickerView['projects'][number]): string => {
    const tail = project.path?.split('/').filter(Boolean).slice(-2).join('/');
    return oneLine(names.get(project.name)! > 1 && tail ? `${project.name} · ${tail}` : project.name, 100) || project.id;
  };
  const control = select({
    options: view.projects.slice(0, 100).map(project => ({ value: project.id, label: label(project) })),
    ...(selected ? { value: selected.id } : {}), action: ACTION_PICK, ref: view.ref,
  });
  return kitCard({ title, elements: [selectBlock('项目', control, HERO)] });
}

// ── Model picker and command panel ──

export function modelPickerCard(view: ModelPickerView): Card {
  const scope = view.scope === 'session' ? `当前会话 · ${safe(view.backend.name, 40)}` : '这个聊天的新会话';
  const hero: CardElement[] = [md(`**${safe(view.summary, 200)}**`), note(scope)];
  if (view.note) hero.push(note(safe(view.note, 200)));
  const elements: CardElement[] = [surface(HERO, hero)];
  if (view.error) elements.push(surface(STRONG, [md(`**${safe(view.error, 300)}**`)]));
  const blocks: Array<[string, CardElement]> = [];
  if (view.backends) {
    blocks.push(['Agent', select({ options: view.backends.map(backend => ({ value: backend.id, label: backend.name })), value: view.backend.id, action: 'backend', ref: view.ref })]);
  }
  if (view.models.length) blocks.push(['模型', select({ options: view.models.map(model => ({ value: model.id, label: model.name })), value: view.modelId, action: 'model', ref: view.ref })]);
  for (const param of view.params) {
    blocks.push([param.label, select({ options: param.options, value: param.value, action: `param:${param.id}`, ref: view.ref })]);
  }
  // Blocks alternate with the hero: the first select shares its colour with the next, never with the hero above.
  blocks.forEach(([label, control], index) => elements.push(selectBlock(label, control, index % 2 === 0 ? SUB : HERO)));
  return kitCard({ title: '模型', elements });
}

export function commandPanelCard(view: CommandPanelView): Card {
  const elements: CardElement[] = view.sections.map((section, index) =>
    surface(index % 2 === 0 ? HERO : SUB, commandGroup(section.title, section.commands.map(command => [command.usage, command.description]))));
  if (view.quick.length) elements.push(buttonRow(view.quick.map(item => ({ text: item.label, value: callbackValue(view.ref, item.action) }))));
  if (view.note) elements.push(note(safe(view.note, 200)));
  return kitCard({ title: 'Riffet 命令', subtitle: '输入命令，或直接发消息开始对话', elements });
}

export const panelCard = (view: PanelView): Card => view.kind === 'model-picker' ? modelPickerCard(view) : commandPanelCard(view);

export const redrawCard = (view: InteractionView | ProjectPickerView | PanelView): Card =>
  view.kind === 'interaction' ? interactionCard(view) : view.kind === 'project-picker' ? projectPickerCard(view) : panelCard(view);

export type { CardElement, TableMode };
