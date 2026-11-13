// What a click or an Enter would do (docs/BROWSER.md §6): the word lists of the Android classifier
// (`apps/mobile/client/.../DeviceSafety.kt`, after Mika's `IrreversibleDetector`, Apache-2.0), applied to a web
// element's accessible name and text. Names only, no understanding of the page; when unsure it asks.

import { listSetting } from '@riffet/plugin-api';
import type { BrowserRiskCategory } from './protocol.js';

const STRONG: Array<[string, BrowserRiskCategory]> = [
  ['支付', 'pay'], ['付款', 'pay'], ['转账', 'pay'],
  ['删除', 'delete'], ['撤回', 'delete'],
  ['下单', 'order'], ['购买', 'order'], ['结算', 'order'], ['结账', 'order'], ['取消订单', 'order'], ['确认收货', 'order'], ['退款', 'order'],
  ['转发', 'send'],
];
const STRONG_MAX_LEN = 12;
const STATUS_PREFIXES = new Set(['待', '已']);
const STATUS_SUFFIXES = ['成功', '记录', '售后', '明细', '方式', '列表', '中心', '入口', '码'];
const EXACT_PAY = ['收银台', '买单', '充值', '储值', '提现', '转出', '打赏', '缴费', '捐赠', '捐款'];
const EXACT_PAY_PREFIXES = ['', '立即', '确认', '去'];
const RED_PACKET = new Set(['红包', '发红包', '塞钱进红包']);
const PREFIX_WORDS: Array<[string, BrowserRiskCategory]> = [
  ['发送', 'send'], ['传送', 'send'], ['发布', 'send'], ['发表', 'send'],
  ['清空', 'delete'], ['移除', 'delete'], ['注销', 'delete'], ['退出群聊', 'delete'],
  ['提交订单', 'order'],
];
const PREFIX_SLACK = 4;
const PUNCT_WORDS = ['评论', '回复'];
const BOOKING_WORDS = ['预约', '报名'];
const BOOKING_PREFIXES = ['', '立即', '确认'];
const SUBMIT_WORDS = new Set(['提交', '确认提交', '送出', 'submit']);
const ENGLISH: Array<[string, BrowserRiskCategory]> = [
  ['send', 'send'], ['post', 'send'], ['reply', 'send'], ['publish', 'send'], ['tweet', 'send'],
  ['pay', 'pay'], ['donate', 'pay'], ['transfer', 'pay'],
  ['delete', 'delete'], ['remove', 'delete'], ['clear all', 'delete'],
  ['place order', 'order'], ['buy now', 'order'], ['checkout', 'order'], ['check out', 'order'], ['complete purchase', 'order'],
];
const EXCLUDED = ['支付宝', '支付方式', '支付设置', '付款方式'];
const SEARCH = ['search', '搜索', '搜寻'];
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

function actionAt(text: string, word: string, index: number): boolean {
  if (index > 0 && STATUS_PREFIXES.has(text[index - 1]!)) return false;
  const rest = text.slice(index + word.length).replace(/^[^\p{L}\p{N}]+/u, '');
  return !STATUS_SUFFIXES.some(suffix => rest.startsWith(suffix));
}

function strong(label: string): BrowserRiskCategory | undefined {
  for (const part of [label, ...label.split(/\s+/)]) {
    let text = part.replace(/\s+/g, '');
    for (const word of EXCLUDED) text = text.split(word).join('');
    if (!text || text.length > STRONG_MAX_LEN) continue;
    for (const [word, category] of STRONG) {
      for (let index = text.indexOf(word); index >= 0; index = text.indexOf(word, index + 1)) if (actionAt(text, word, index)) return category;
    }
  }
  return undefined;
}

/** The category of a button's name, or undefined. */
export function ofName(name: string): BrowserRiskCategory | undefined {
  const raw = name.trim();
  if (!raw || raw.length > 200) return undefined;
  const compact = raw.replace(/\s+/g, '').toLowerCase();
  if (SUBMIT_WORDS.has(compact)) return 'submit';
  if (RED_PACKET.has(compact)) return 'pay';
  if (EXACT_PAY.some(word => EXACT_PAY_PREFIXES.some(prefix => compact === prefix + word))) return 'pay';
  const found = strong(raw);
  if (found) return found;
  for (const [word, category] of PREFIX_WORDS) if (compact.startsWith(word) && compact.length <= word.length + PREFIX_SLACK) return category;
  for (const word of PUNCT_WORDS) if (compact.startsWith(word) && ![...compact.slice(word.length)].some(isWordChar)) return 'send';
  if (BOOKING_WORDS.some(word => BOOKING_PREFIXES.some(prefix => compact === prefix + word))) return 'order';
  const lower = raw.toLowerCase().replace(/\s+/g, ' ');
  for (const [word, category] of ENGLISH) if (lower.startsWith(word) && !/\p{L}/u.test(lower[word.length] ?? '')) return category;
  return undefined;
}

/** What the element a click lands on looks like to the classifier. */
export interface TargetInfo {
  /** Accessible name, text content, value of a button-like input. */
  names: string[];
  /** `id`, `name`, `class`, `data-testid` and the like, split into words by the caller. */
  idWords: string[];
  /** The element submits a form (`type=submit`, or a button inside a form without a type). */
  submits: boolean;
  /** For Enter in a field: placeholder, name, type, role. */
  fieldHints?: string;
}

const ID_WORDS: Record<string, BrowserRiskCategory> = { send: 'send', reply: 'send', pay: 'pay', delete: 'delete', remove: 'delete', checkout: 'order', purchase: 'order' };

/** A click on the target. */
export function ofClick(target: TargetInfo): BrowserRiskCategory | undefined {
  for (const name of target.names) { const category = ofName(name); if (category) return category; }
  for (const word of target.idWords) { const category = ID_WORDS[word]; if (category) return category; }
  return target.submits ? 'submit' : undefined;
}

/** Enter pressed in a field: it sends or submits, unless the field is a search box. */
export function ofEnter(target: TargetInfo | undefined): BrowserRiskCategory | undefined {
  const hay = `${target?.fieldHints ?? ''} ${target?.names.join(' ') ?? ''} ${target?.idWords.join(' ') ?? ''}`.toLowerCase();
  if (SEARCH.some(word => hay.includes(word))) return undefined;
  if (target && /\btextarea\b/.test(target.fieldHints ?? '')) return undefined;
  return 'send';
}

// ── Sites ───────────────────────────────────────────────────────────────────

/** `example.com` and `*.example.com`, lowercase, from a comma or newline separated setting. */
export function sitePatterns(setting: string | undefined): string[] {
  return listSetting(setting).flatMap(item => item.split(/[,\s]+/)).map(item => item.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
}

export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return patterns.some(pattern => {
    if (pattern.startsWith('*.')) { const base = pattern.slice(2); return name === base || name.endsWith(`.${base}`); }
    return name === pattern || name.endsWith(`.${pattern}`);
  });
}

/** A development server on this machine: verifying one's own app should not ask. */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name) || name === '0.0.0.0';
}

/** What was typed or asked for, with a scheme: `localhost:3000` and `127.0.0.1` get http, a bare host https. */
export function withScheme(text: string): string {
  const value = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(about|file|data|javascript|mailto|blob):/i.test(value)) return value;
  return `${/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(value) ? 'http' : 'https'}://${value}`;
}
