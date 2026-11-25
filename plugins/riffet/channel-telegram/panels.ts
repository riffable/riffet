/*
 * Inline keyboard panels, interactive prompts and compact callback-data storage for Telegram.
 *
 * Telegram caps `callback_data` at 64 bytes. Every button carries a short opaque token (`t:<id>`)
 * resolved inside the connection's bounded in-memory table, never stuffing ids or text into the wire.
 *
 * Uses Bot API 9.4+ semantic button styles (`primary`, `success`, `danger`) with automatic fallback
 * in `surface.ts` when an older Bot API server rejects the field.
 */
import { randomBytes } from 'node:crypto';
import type {
  CommandPanelView, InteractionView, ModelPickerView, PanelView, ProjectPickerView,
} from '@riffet/plugin-api';
import type { InlineButtonStyle, InlineKeyboardButton, InlineKeyboardMarkup } from './api.js';
import { escapeHtml } from './format.js';

const CALLBACK_TTL_MS = 24 * 60 * 60_000;
const CALLBACK_CAP = 2000;
const PROJECT_PAGE_SIZE = 8;
const MODEL_PAGE_SIZE = 6;

export type ModelTab = 'main' | 'backends' | 'models';

export type CallbackPayload =
  | { kind: 'core'; ref: string; action: string; selectedIds?: string[] }
  | { kind: 'page'; view: 'project'; ref: string; page: number }
  | { kind: 'model-tab'; ref: string; tab: ModelTab; page?: number }
  | { kind: 'toggle'; ref: string; optionId: string }
  | { kind: 'submit-multi'; ref: string; action: string }
  | { kind: 'other'; ref: string; action: string };

interface CallbackEntry { payload: CallbackPayload; at: number }

export interface RenderedMessage {
  html: string;
  replyMarkup?: InlineKeyboardMarkup;
}

/** Per-connection bounded map of short callback tokens (`<= 14 bytes`) and local UI pagination/selection state. */
export class TelegramPanelStore {
  private readonly tokens = new Map<string, CallbackEntry>();
  private readonly projectViews = new Map<string, ProjectPickerView>();
  private readonly modelViews = new Map<string, ModelPickerView>();
  private readonly interactionViews = new Map<string, InteractionView>();
  private readonly selected = new Map<string, Set<string>>();

  register(payload: CallbackPayload): string {
    const now = Date.now();
    if (this.tokens.size >= CALLBACK_CAP) {
      for (const [key, item] of this.tokens) {
        if (now - item.at > CALLBACK_TTL_MS || this.tokens.size >= CALLBACK_CAP) this.tokens.delete(key);
        if (this.tokens.size < CALLBACK_CAP * 0.8) break;
      }
    }
    const token = `t:${randomBytes(6).toString('base64url')}`;
    this.tokens.set(token, { payload, at: now });
    return token;
  }

  resolve(data: string | undefined): CallbackPayload | undefined {
    if (!data) return undefined;
    const entry = this.tokens.get(data);
    if (!entry) return undefined;
    if (Date.now() - entry.at > CALLBACK_TTL_MS) {
      this.tokens.delete(data);
      return undefined;
    }
    return entry.payload;
  }

  private boundMap<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > 200) map.delete(map.keys().next().value!);
  }

  toggleOption(ref: string, optionId: string): Set<string> {
    let set = this.selected.get(ref);
    if (!set) { set = new Set(); this.boundMap(this.selected, ref, set); }
    if (set.has(optionId)) set.delete(optionId);
    else set.add(optionId);
    return set;
  }

  selectedOf(ref: string): string[] {
    return [...(this.selected.get(ref) ?? [])];
  }

  clearSelection(ref: string): void {
    this.selected.delete(ref);
  }

  projectView(ref: string): ProjectPickerView | undefined { return this.projectViews.get(ref); }
  modelView(ref: string): ModelPickerView | undefined { return this.modelViews.get(ref); }
  interactionView(ref: string): InteractionView | undefined { return this.interactionViews.get(ref); }

  renderProjectPicker(view: ProjectPickerView, page = 0): RenderedMessage {
    const picked = view.projects.find(item => item.id === view.selectedId);
    if (view.closed) {
      this.projectViews.delete(view.ref);
      return { html: picked ? `<b>项目</b>\n✓ <code>${escapeHtml(picked.name)}</code>` : '<b>项目</b>\n✓ 已选择' };
    }
    this.boundMap(this.projectViews, view.ref, view);
    const totalPages = Math.max(1, Math.ceil(view.projects.length / PROJECT_PAGE_SIZE));
    const current = Math.max(0, Math.min(page, totalPages - 1));
    const slice = view.projects.slice(current * PROJECT_PAGE_SIZE, (current + 1) * PROJECT_PAGE_SIZE);
    const useTwoCols = slice.length >= 4 && slice.every(item => item.name.length <= 16);
    const buttons: InlineKeyboardButton[] = slice.map(project => {
      const active = project.id === view.selectedId;
      return {
        text: `${active ? '✓ ' : ''}${project.name}`,
        callback_data: this.register({ kind: 'core', ref: view.ref, action: 'pick', selectedIds: [project.id] }),
        ...(active ? { style: 'primary' as const } : {}),
      };
    });
    const rows = chunkButtons(buttons, useTwoCols ? 2 : 1);
    if (totalPages > 1) {
      const pager: InlineKeyboardButton[] = [];
      if (current > 0) pager.push({ text: '← 上一页', callback_data: this.register({ kind: 'page', view: 'project', ref: view.ref, page: current - 1 }) });
      if (current + 1 < totalPages) pager.push({ text: '下一页 →', callback_data: this.register({ kind: 'page', view: 'project', ref: view.ref, page: current + 1 }) });
      rows.push(pager);
    }
    const header = totalPages > 1 ? `<b>选择项目</b>  <i>${current + 1}/${totalPages}</i>` : '<b>选择项目</b>';
    const lines = picked ? [header, `当前：<code>${escapeHtml(picked.name)}</code>`] : [header];
    return { html: lines.join('\n'), replyMarkup: { inline_keyboard: rows } };
  }

  renderCommandPanel(view: CommandPanelView): RenderedMessage {
    const parts: string[] = [];
    for (const section of view.sections) {
      if (!section.commands.length) continue;
      const lines = section.commands.map(cmd => `<code>${escapeHtml(cmd.usage)}</code>  ${escapeHtml(cmd.description)}`);
      parts.push(`<b>${escapeHtml(section.title)}</b>\n${lines.join('\n')}`);
    }
    if (view.note) parts.push(`<i>${escapeHtml(view.note)}</i>`);
    const buttons: InlineKeyboardButton[] = view.quick.map(item => ({
      text: item.label,
      callback_data: this.register({ kind: 'core', ref: view.ref, action: item.action }),
    }));
    return {
      html: parts.join('\n\n') || '<b>命令</b>',
      ...(buttons.length ? { replyMarkup: { inline_keyboard: [buttons] } } : {}),
    };
  }

  renderModelPicker(view: ModelPickerView, options?: { tab?: ModelTab; page?: number }): RenderedMessage {
    this.boundMap(this.modelViews, view.ref, view);
    const tab = options?.tab ?? 'main';
    const currentModel = view.models.find(item => item.id === view.modelId);
    const modelDisplay = currentModel?.name ?? (view.modelId || '默认');
    const summaryParts = view.summary.split(' · ');
    const formattedSummary = summaryParts.length > 1
      ? `<code>${escapeHtml(summaryParts[0]!)}</code> · ${escapeHtml(summaryParts.slice(1).join(' · '))}`
      : `<code>${escapeHtml(view.summary)}</code>`;

    const lines = [
      `<b>${view.scope === 'session' ? '会话模型' : '默认模型'}</b>  ·  ${escapeHtml(view.backend.name)}`,
      formattedSummary,
    ];
    if (view.note) lines.push(`<i>${escapeHtml(view.note)}</i>`);
    if (view.error) lines.push(`<b>错误：</b>${escapeHtml(view.error)}`);

    const rows: InlineKeyboardButton[][] = [];

    if (tab === 'backends' && view.scope === 'chat' && view.backends && view.backends.length > 1) {
      lines.push('<i>选择 Agent</i>');
      rows.push(...chunkButtons(view.backends.map(backend => {
        const active = backend.id === view.backend.id;
        return {
          text: `${active ? '✓ ' : ''}${backend.name}`,
          callback_data: this.register({ kind: 'core', ref: view.ref, action: 'backend', selectedIds: [backend.id] }),
          ...(active ? { style: 'primary' as const } : {}),
        };
      }), 3));
      rows.push([{ text: '← 返回', callback_data: this.register({ kind: 'model-tab', ref: view.ref, tab: 'main' }) }]);
      return { html: lines.join('\n'), replyMarkup: { inline_keyboard: rows } };
    }

    if (tab === 'models' && view.models.length > 0) {
      const totalPages = Math.max(1, Math.ceil(view.models.length / MODEL_PAGE_SIZE));
      const current = Math.max(0, Math.min(options?.page ?? 0, totalPages - 1));
      lines.push(totalPages > 1 ? `<i>选择模型  ${current + 1}/${totalPages}</i>` : '<i>选择模型</i>');
      const slice = view.models.slice(current * MODEL_PAGE_SIZE, (current + 1) * MODEL_PAGE_SIZE);
      rows.push(...chunkButtons(slice.map(model => {
        const active = model.id === view.modelId;
        return {
          text: `${active ? '✓ ' : ''}${model.name}`,
          callback_data: this.register({ kind: 'core', ref: view.ref, action: 'model', selectedIds: [model.id] }),
          ...(active ? { style: 'primary' as const } : {}),
        };
      }), 2));
      const navRow: InlineKeyboardButton[] = [
        { text: '← 返回', callback_data: this.register({ kind: 'model-tab', ref: view.ref, tab: 'main' }) },
      ];
      if (current > 0) navRow.push({ text: '上一页', callback_data: this.register({ kind: 'model-tab', ref: view.ref, tab: 'models', page: current - 1 }) });
      if (current + 1 < totalPages) navRow.push({ text: '下一页', callback_data: this.register({ kind: 'model-tab', ref: view.ref, tab: 'models', page: current + 1 }) });
      rows.push(navRow);
      return { html: lines.join('\n'), replyMarkup: { inline_keyboard: rows } };
    }

    // Main compact view: one selector row for Agent / Model, followed by direct 1-tap parameter rows.
    const selectorRow: InlineKeyboardButton[] = [];
    if (view.scope === 'chat' && view.backends && view.backends.length > 1) {
      selectorRow.push({
        text: `Agent: ${view.backend.name} ▾`,
        callback_data: this.register({ kind: 'model-tab', ref: view.ref, tab: 'backends' }),
      });
    }
    if (view.models.length > 1) {
      const selectedIdx = Math.max(0, view.models.findIndex(item => item.id === view.modelId));
      const initialPage = Math.floor(selectedIdx / MODEL_PAGE_SIZE);
      selectorRow.push({
        text: `模型: ${modelDisplay} ▾`,
        callback_data: this.register({ kind: 'model-tab', ref: view.ref, tab: 'models', page: initialPage }),
      });
    }
    if (selectorRow.length) rows.push(selectorRow);

    for (const param of view.params) {
      if (!param.options.length) continue;
      // Only prefix ambiguous binary labels like "开"/"关"; self-explanatory values (Low/High, 标准/快速) stay clean.
      const needsPrefix = param.options.every(option => option.label === '开' || option.label === '关' || option.label === 'On' || option.label === 'Off');
      const allShort = !needsPrefix && param.options.every(option => option.label.length <= 7);
      const perRow = param.options.length <= 2 ? 2
        : allShort && param.options.length <= 5 ? param.options.length
          : param.options.length <= 4 ? param.options.length
            : 3;
      rows.push(...chunkButtons(param.options.map(option => {
        const active = option.value === param.value;
        return {
          text: `${active ? '✓ ' : ''}${needsPrefix ? `${param.label}: ` : ''}${option.label}`,
          callback_data: this.register({ kind: 'core', ref: view.ref, action: `param:${param.id}`, selectedIds: [option.value] }),
          ...(active ? { style: 'primary' as const } : {}),
        };
      }), perRow));
    }

    return {
      html: lines.join('\n'),
      ...(rows.length ? { replyMarkup: { inline_keyboard: rows } } : {}),
    };
  }

  renderPanel(view: PanelView): RenderedMessage {
    return view.kind === 'model-picker' ? this.renderModelPicker(view) : this.renderCommandPanel(view);
  }

  renderInteraction(view: InteractionView): RenderedMessage {
    const { interaction } = view;
    const progress = interaction.questionIndex && interaction.questionCount && interaction.questionCount > 1
      ? `  <i>${interaction.questionIndex}/${interaction.questionCount}</i>`
      : '';
    const rawTitle = interaction.title || (interaction.kind === 'permission' ? '权限确认' : '需要回答');
    const lines: string[] = [`<b>${escapeHtml(rawTitle)}</b>${progress}`];
    if (interaction.message) {
      const body = escapeHtml(interaction.message);
      lines.push(interaction.kind === 'permission' || interaction.kind === 'confirmation'
        ? `<blockquote>${body}</blockquote>`
        : body);
    }

    if (view.closed) {
      this.interactionViews.delete(view.ref);
      this.clearSelection(view.ref);
      const outcomeText = view.closed.label
        ? `${view.closed.outcome === 'answered' ? '✓ ' : ''}${view.closed.label}`
        : (
          view.closed.outcome === 'answered' ? '✓ 已处理'
            : view.closed.outcome === 'answered-elsewhere' ? '已在其他端处理'
              : view.closed.outcome === 'expired' ? '已过期'
                : '已取消'
        );
      lines.push(`<i>${escapeHtml(outcomeText)}</i>`);
      return { html: lines.join('\n\n') };
    }

    this.boundMap(this.interactionViews, view.ref, view);
    const rows: InlineKeyboardButton[][] = [];
    const options = interaction.options ?? [];
    const actions = interaction.actions ?? [];
    const primaryAction = actions.find(item => item.tone === 'primary')?.id ?? actions[0]?.id ?? 'submit';

    for (const action of actions) {
      if (action.detail) lines.push(`• <b>${escapeHtml(action.shortLabel || action.label)}</b> — ${escapeHtml(action.detail)}`);
    }

    const actionStyle = (tone?: 'primary' | 'danger'): InlineButtonStyle | undefined => {
      if (tone === 'danger') return 'danger';
      if (tone === 'primary') return interaction.kind === 'permission' ? 'success' : 'primary';
      return undefined;
    };

    if (options.length > 0) {
      if (interaction.multiple && !this.selected.has(view.ref)) {
        const pre = new Set(options.filter(option => option.selected).map(option => option.id));
        if (pre.size) this.boundMap(this.selected, view.ref, pre);
      }
      const selected = this.selected.get(view.ref) ?? new Set<string>();
      if (interaction.multiple) {
        for (const option of options) {
          const picked = selected.has(option.id);
          rows.push([{
            text: `${picked ? '✓ ' : ''}${option.label}`,
            callback_data: this.register({ kind: 'toggle', ref: view.ref, optionId: option.id }),
            ...(picked ? { style: 'primary' as const } : {}),
          }]);
        }
        const submitRow: InlineKeyboardButton[] = [{
          text: `提交${selected.size ? ` (${selected.size})` : ''}`,
          callback_data: this.register({ kind: 'submit-multi', ref: view.ref, action: primaryAction }),
          style: 'primary',
        }];
        if (interaction.allowOther) {
          submitRow.push({
            text: '其他…',
            callback_data: this.register({ kind: 'other', ref: view.ref, action: primaryAction }),
          });
        }
        rows.push(submitRow);
      } else {
        const useTwoCols = options.length >= 2 && options.length <= 6 && options.every(option => option.label.length <= 12);
        rows.push(...chunkButtons(options.map(option => ({
          text: option.label,
          callback_data: this.register({ kind: 'core', ref: view.ref, action: primaryAction, selectedIds: [option.id] }),
        })), useTwoCols ? 2 : 1));
        if (interaction.allowOther) {
          rows.push([{
            text: '其他…',
            callback_data: this.register({ kind: 'other', ref: view.ref, action: primaryAction }),
          }]);
        }
      }
      // Secondary actions (e.g. Cancel / Deny) stay available below the options.
      const extraActions = actions.filter(item => item.id !== primaryAction);
      if (extraActions.length) {
        rows.push(extraActions.map(action => {
          const style = actionStyle(action.tone);
          return {
            text: action.shortLabel || action.label,
            callback_data: this.register({ kind: 'core', ref: view.ref, action: action.id }),
            ...(style ? { style } : {}),
          };
        }));
      }
    } else if (actions.length > 0) {
      rows.push(...chunkButtons(actions.map(action => {
        const style = actionStyle(action.tone);
        return {
          text: action.shortLabel || action.label,
          callback_data: this.register({ kind: 'core', ref: view.ref, action: action.id }),
          ...(style ? { style } : {}),
        };
      }), 2));
      if (interaction.allowOther) {
        rows.push([{
          text: '其他…',
          callback_data: this.register({ kind: 'other', ref: view.ref, action: primaryAction }),
        }]);
      }
    } else if (interaction.allowOther) {
      rows.push([{
        text: '输入回复',
        callback_data: this.register({ kind: 'other', ref: view.ref, action: primaryAction }),
        style: 'primary',
      }]);
    }

    return {
      html: lines.join('\n\n'),
      ...(rows.length ? { replyMarkup: { inline_keyboard: rows } } : {}),
    };
  }
}

function chunkButtons(buttons: InlineKeyboardButton[], perRow: number): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}
