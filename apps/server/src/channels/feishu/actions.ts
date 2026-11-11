/*
 * Card callbacks. `card.action.trigger` arrives with the pressed control's value, or for a form
 * submit the form's fields and the button's `name` (Feishu clears a submit button's value). The
 * answer to the callback is the card's new state, returned synchronously: a card refreshed only by
 * a later PATCH flashes back to its old state.
 */
import type { ActionReply, InboundAction } from '../types.js';
import { ACTION_ANSWER, FORM_FIELD_OTHER, FORM_FIELD_PICK, FORM_SUBMIT_PREFIX, parseCallbackValue, redrawCard } from './cards.js';

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose => (value && typeof value === 'object' ? value as Loose : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function optionValue(option: unknown): string | undefined {
  return typeof option === 'string' ? option || undefined : text(record(option).value);
}

/** `value` can arrive as an object or as its JSON text. */
function valueOf(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return undefined; }
}

export function normalizeCardAction(raw: unknown, account: string): InboundAction | undefined {
  const root = record(raw);
  const event = record(root.event ?? root);
  const header = record(root.header);
  const action = record(event.action);
  const eventId = text(header.event_id) ?? text(root.event_id) ?? text(event.token) ?? text(root.token);
  const operatorId = text(record(event.operator).open_id) ?? text(record(record(event.operator).operator_id).open_id);
  if (!eventId || !operatorId) return undefined;

  const form = record(action.form_value);
  const name = text(action.name);
  const submitted = name?.startsWith(FORM_SUBMIT_PREFIX) ? name.slice(FORM_SUBMIT_PREFIX.length) : undefined;
  const value = parseCallbackValue(valueOf(action.value));
  const ref = value?.ref ?? submitted;
  if (!ref) return undefined;

  const selected: string[] = [];
  const pick = form[FORM_FIELD_PICK];
  if (Array.isArray(pick)) selected.push(...pick.map(optionValue).filter((id): id is string => Boolean(id)));
  else if (optionValue(pick)) selected.push(optionValue(pick)!);
  const single = optionValue(action.option);
  if (single) selected.push(single);
  if (Array.isArray(action.options)) selected.push(...action.options.map(optionValue).filter((id): id is string => Boolean(id)));

  const otherText = text(form[FORM_FIELD_OTHER])?.replace(/[\r\n]+/g, ' ').trim();
  return {
    account,
    eventId,
    operator: { id: operatorId },
    ref,
    action: value?.action ?? ACTION_ANSWER,
    ...(selected.length ? { selectedIds: [...new Set(selected)] } : {}),
    ...(otherText ? { otherText } : {}),
  };
}

/** The synchronous callback response: a toast, and/or the card redrawn in place. */
export function toCallbackResponse(reply: ActionReply): Record<string, unknown> {
  return {
    ...(reply.toast ? { toast: { type: reply.toast.tone, content: reply.toast.text } } : {}),
    ...(reply.redraw ? { card: { type: 'raw', data: redrawCard(reply.redraw) } } : {}),
  };
}
