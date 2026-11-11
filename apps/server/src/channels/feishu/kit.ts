/*
 * The Feishu card kit: every card except the streaming turn card is assembled from these
 * primitives (docs/design/channels.md, 「卡片体系」). One grey family, bold for emphasis, no
 * decorative colour; a card is a header, then colour blocks, then actions and a note.
 */
import { renderMarkdown, type CardElement } from './markdown.js';

export type Card = Record<string, unknown>;

/** Block colours: the primary content, the secondary content (alternating with it), and what needs attention. */
export const HERO = 'grey-100';
export const SUB = 'grey-50';
export const STRONG = 'grey-200';
export type Tone = typeof HERO | typeof SUB | typeof STRONG;

export const NAME_MAX = 100;

// ── Text ──

export const plain = (content: string) => ({ tag: 'plain_text', content });

/** One line of at most `max` characters with no angle brackets, for plain text and card labels. */
export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** User text placed inside a markdown element: one line, and no `<` that could open a tag. */
export const safe = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/</g, '＜').replace(/>/g, '＞');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// ── Callback values ──

/** What every control carries back: the core's opaque ref and the action it stands for. */
export interface CallbackValue { v: 1; ref: string; action: string }
export const callbackValue = (ref: string, action: string): CallbackValue => ({ v: 1, ref, action });

// ── Primitives ──

/** A card without a title has no header bar. */
export function card({ title, subtitle, elements }: { title?: string; subtitle?: string; elements: CardElement[] }): Card {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    ...(title ? { header: { title: plain(title), ...(subtitle ? { subtitle: plain(subtitle) } : {}), template: 'default' } } : {}),
    body: { elements },
  };
}

export const surface = (tone: Tone, elements: CardElement[]): CardElement => ({
  tag: 'interactive_container',
  width: 'fill',
  background_style: tone,
  has_border: false,
  corner_radius: '8px',
  padding: '12px 16px 12px 16px',
  elements,
});

export const md = (text: string): CardElement => ({ tag: 'markdown', content: text });

/** Grey small print. The text is already safe markdown. */
export const note = (text: string): CardElement => ({ tag: 'markdown', content: `<font color='grey'>${text}</font>`, text_size: 'notation' });

/** A titled list of commands: a bold line per command, its grey description indented below. */
export function commandGroup(title: string, commands: Array<[usage: string, description: string]>): CardElement[] {
  const lines = [`**${safe(title, 40)}**`];
  for (const [usage, description] of commands) {
    lines.push(`**${safe(usage, 60)}**`, `　　<font color='grey'>${safe(description, 100)}</font>`);
  }
  return [md(lines.join('\n'))];
}

export interface ButtonSpec { text: string; value: CallbackValue; type?: 'default' | 'primary' | 'danger' }

export const buttonRow = (buttons: ButtonSpec[]): CardElement => ({
  tag: 'column_set',
  flex_mode: 'flow',
  horizontal_spacing: 'small',
  columns: buttons.map(button => ({
    tag: 'column', width: 'auto', vertical_align: 'center',
    elements: [{
      tag: 'button',
      text: plain(oneLine(button.text, 20) || button.value.action),
      type: button.type ?? 'default',
      size: 'medium',
      behaviors: [{ type: 'callback', value: button.value }],
    }],
  })),
});

/** A callback select; outside a form, since inside one a select never fires its change callback. */
export function select({ options, value, action, ref }: {
  options: Array<{ value: string; label: string }>; value?: string; action: string; ref: string;
}): CardElement {
  const listed = options.slice(0, 100);
  return {
    tag: 'select_static', width: 'fill', placeholder: plain('选择'),
    options: listed.map(option => ({ text: plain(oneLine(option.label, 100) || option.value), value: option.value })),
    ...(value !== undefined && listed.some(option => option.value === value) ? { initial_option: value } : {}),
    behaviors: [{ type: 'callback', value: callbackValue(ref, action) }],
  };
}

/** A bold label line over a full-width control, in one colour block. */
export const selectBlock = (label: string, control: CardElement, tone: Tone = SUB): CardElement =>
  surface(tone, [md(`**${safe(label, 40)}**`), control]);

/** A notice or an error: the markdown text alone in one block. Errors use `STRONG`. */
export const simpleCard = (title: string | undefined, text: string, tone: Tone = HERO): Card =>
  card({ ...(title ? { title } : {}), elements: [surface(tone, renderMarkdown(text, { single: true }))] });
