/*
 * Markdown and TurnView → Telegram HTML.
 *
 * Parses Markdown through `remark` + `remark-gfm` into an mdast tree so every emitted HTML tag is
 * balanced and safe. Long replies split at block or code-line boundaries to stay under Telegram's
 * 4096-character limit without ever leaving an unclosed tag.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Blockquote, Code, Heading, List, ListItem, PhrasingContent, Root, RootContent, Table } from 'mdast';
import type { TurnFooter, TurnStep, TurnView } from '@riffet/plugin-api';

export const TELEGRAM_MAX_VISIBLE = 3800;
const MAX_PROCESS_CHARS = 900;
const MAX_PROMPT_CHARS = 300;
const SAFE_HREF = /^(https?:|tg:|mailto:)/i;

const parser = unified().use(remarkParse).use(remarkGfm);

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function visibleLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;|&gt;|&amp;|&quot;/g, 'x')
    .length;
}

function renderInline(nodes: readonly PhrasingContent[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += escapeHtml(node.value);
        break;
      case 'break':
        out += '\n';
        break;
      case 'inlineCode':
        out += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case 'strong':
        out += `<b>${renderInline(node.children)}</b>`;
        break;
      case 'emphasis':
        out += `<i>${renderInline(node.children)}</i>`;
        break;
      case 'delete':
        out += `<s>${renderInline(node.children)}</s>`;
        break;
      case 'link': {
        const inner = renderInline(node.children) || escapeHtml(node.url);
        out += SAFE_HREF.test(node.url) ? `<a href="${escapeAttr(node.url)}">${inner}</a>` : inner;
        break;
      }
      case 'image': {
        if (SAFE_HREF.test(node.url)) {
          out += `<a href="${escapeAttr(node.url)}">${escapeHtml(node.alt || '图片')}</a>`;
        }
        break;
      }
      case 'html':
        out += escapeHtml(node.value);
        break;
      default:
        break;
    }
  }
  return out;
}

function plainText(nodes: readonly PhrasingContent[]): string {
  let out = '';
  for (const node of nodes) {
    if ('value' in node && typeof node.value === 'string') out += node.value;
    else if ('children' in node && Array.isArray(node.children)) out += plainText(node.children as PhrasingContent[]);
  }
  return out;
}

function renderTable(table: Table): string {
  const rows = table.children.map(row => row.children.map(cell => plainText(cell.children).replace(/\s+/g, ' ').trim()));
  if (!rows.length) return '';
  const colCount = Math.max(...rows.map(row => row.length));
  const widths = Array.from({ length: colCount }, (_, col) =>
    Math.min(32, Math.max(1, ...rows.map(row => (row[col] ?? '').length))),
  );
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 1)).join(' | ');
  const lines = [formatRow(rows[0] ?? [])];
  if (rows.length > 1) {
    lines.push(widths.map(width => '-'.repeat(width)).join('-+-'));
    for (const row of rows.slice(1)) lines.push(formatRow(row));
  }
  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

function renderCode(code: Code): string {
  const lang = code.lang && /^[\w+#.-]{1,30}$/.test(code.lang) ? code.lang : '';
  const body = escapeHtml(code.value.replace(/\n+$/, ''));
  return lang ? `<pre><code class="language-${escapeAttr(lang)}">${body}</code></pre>` : `<pre>${body}</pre>`;
}

function renderList(list: List, depth = 0): string {
  const indent = '  '.repeat(depth);
  const start = list.start ?? 1;
  const lines: string[] = [];
  list.children.forEach((item: ListItem, index: number) => {
    const bullet = list.ordered ? `${start + index}. ` : '• ';
    const parts: string[] = [];
    for (const child of item.children) {
      if (child.type === 'paragraph') parts.push(renderInline(child.children));
      else if (child.type === 'list') parts.push(renderList(child, depth + 1));
      else if (child.type === 'code') parts.push(renderCode(child));
      else if (child.type === 'blockquote') parts.push(renderBlockquote(child));
      else if (child.type === 'table') parts.push(renderTable(child));
    }
    const [first, ...rest] = parts;
    if (first !== undefined) lines.push(`${indent}${bullet}${first}`);
    for (const extra of rest) lines.push(extra);
  });
  return lines.join('\n');
}

function renderBlockquote(node: Blockquote): string {
  const blocks = renderBlocks(node.children);
  const inner = blocks.join('\n\n').trim();
  return inner ? `<blockquote>${inner}</blockquote>` : '';
}

function renderHeading(node: Heading): string {
  const text = renderInline(node.children);
  return text ? `<b>${text}</b>` : '';
}

function renderBlocks(nodes: readonly RootContent[]): string[] {
  const blocks: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph': {
        const text = renderInline(node.children).trim();
        if (text) blocks.push(text);
        break;
      }
      case 'heading': {
        const text = renderHeading(node);
        if (text) blocks.push(text);
        break;
      }
      case 'code':
        blocks.push(renderCode(node));
        break;
      case 'blockquote': {
        const text = renderBlockquote(node);
        if (text) blocks.push(text);
        break;
      }
      case 'list': {
        const text = renderList(node);
        if (text) blocks.push(text);
        break;
      }
      case 'table': {
        const text = renderTable(node);
        if (text) blocks.push(text);
        break;
      }
      case 'thematicBreak':
        blocks.push('────────');
        break;
      case 'html': {
        const text = escapeHtml(node.value.trim());
        if (text) blocks.push(text);
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

/** Converts Markdown to an array of self-contained Telegram HTML blocks. */
export function markdownToHtmlBlocks(source: string): string[] {
  if (!source.trim()) return [];
  const tree = parser.parse(source) as Root;
  return renderBlocks(tree.children);
}

/** Converts Markdown to a single Telegram HTML string (unsplit). */
export function markdownToHtml(source: string): string {
  return markdownToHtmlBlocks(source).join('\n\n');
}

/** Splits a single oversized `<pre>` block along line boundaries so tags stay balanced. */
function splitPreBlock(block: string, maxVisible: number): string[] {
  const match = /^<pre>(<code class="language-[^"]+">)?([\s\S]*?)(<\/code>)?<\/pre>$/.exec(block);
  if (!match) return splitPlainFallback(block, maxVisible);
  const open = `<pre>${match[1] ?? ''}`;
  const close = `${match[3] ?? ''}</pre>`;
  const lines = match[2]!.split('\n');
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  for (const line of lines) {
    const lineLen = visibleLength(line) + 1;
    if (buf.length && len + lineLen > maxVisible) {
      out.push(`${open}${buf.join('\n')}${close}`);
      buf = [];
      len = 0;
    }
    if (lineLen > maxVisible) {
      const plain = line.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      for (let i = 0; i < plain.length; i += maxVisible) {
        out.push(`${open}${escapeHtml(plain.slice(i, i + maxVisible))}${close}`);
      }
      continue;
    }
    buf.push(line);
    len += lineLen;
  }
  if (buf.length) out.push(`${open}${buf.join('\n')}${close}`);
  return out;
}

/** Strips tags as a last resort when a single non-code block exceeds Telegram's message cap. */
function splitPlainFallback(block: string, maxVisible: number): string[] {
  const plain = block
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  const out: string[] = [];
  let remaining = plain;
  while (remaining.length > maxVisible) {
    let cut = remaining.lastIndexOf('\n', maxVisible);
    if (cut < maxVisible * 0.5) cut = maxVisible;
    out.push(escapeHtml(remaining.slice(0, cut).trimEnd()));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) out.push(escapeHtml(remaining));
  return out;
}

/** Packs HTML blocks into Telegram messages each staying within `maxVisible` visible characters. */
export function packHtmlBlocks(blocks: readonly string[], maxVisible = TELEGRAM_MAX_VISIBLE): string[] {
  const expanded: string[] = [];
  for (const block of blocks) {
    if (!block) continue;
    if (visibleLength(block) <= maxVisible) expanded.push(block);
    else if (block.startsWith('<pre>')) expanded.push(...splitPreBlock(block, maxVisible));
    else expanded.push(...splitPlainFallback(block, maxVisible));
  }
  if (!expanded.length) return [];
  const pages: string[] = [];
  let current = '';
  let currentLen = 0;
  for (const piece of expanded) {
    const pieceLen = visibleLength(piece);
    const sep = current ? 2 : 0;
    if (current && currentLen + sep + pieceLen > maxVisible) {
      pages.push(current);
      current = piece;
      currentLen = pieceLen;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
      currentLen += sep + pieceLen;
    }
  }
  if (current) pages.push(current);
  return pages;
}

function truncate(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

export function renderFooter(footer: TurnFooter, enabled: TurnView['card']['footer']): string {
  const parts: string[] = [];
  if (enabled.model && footer.model) {
    const marks = footer.modelMarks?.length ? ` · ${footer.modelMarks.join(' · ')}` : '';
    parts.push(`<code>${escapeHtml(footer.model)}</code>${escapeHtml(marks)}`);
  }
  if (enabled.changes && footer.changes && (footer.changes.added || footer.changes.removed)) {
    parts.push(escapeHtml(`+${footer.changes.added} −${footer.changes.removed}`));
  }
  if (enabled.context && footer.contextPercent !== undefined) {
    parts.push(escapeHtml(`上下文 ${footer.contextPercent}%`));
  }
  if (enabled.elapsed && footer.elapsedMs !== undefined) {
    parts.push(escapeHtml(formatElapsed(footer.elapsedMs)));
  }
  return parts.length ? `<i>${parts.join(' · ')}</i>` : '';
}

function renderProcess(steps: readonly TurnStep[], final: boolean): string {
  if (!steps.length) return '';
  const lines: string[] = [];
  let toolCount = 0;
  for (const step of steps) {
    if (step.kind === 'tool') {
      toolCount += 1;
      const mark = step.state === 'failed' ? '✗' : step.state === 'done' ? '✓' : '▸';
      lines.push(`${mark} ${step.title || '工具'}`);
    } else if (step.kind === 'plan') {
      lines.push(`• ${step.title || '计划'}`);
    } else {
      const snippet = truncate(step.text.replace(/\s+/g, ' '), final ? 100 : 160);
      if (snippet) lines.push(snippet);
    }
  }
  if (!lines.length) return '';
  const shown = lines.slice(-12);
  const heading = final
    ? (toolCount > 0 ? `过程 · ${toolCount} 次工具调用\n` : '思考过程\n')
    : '';
  const body = truncate(`${heading}${shown.join('\n')}`, MAX_PROCESS_CHARS);
  return `<blockquote expandable>${escapeHtml(body)}</blockquote>`;
}

function runningStatusLine(view: TurnView): string {
  const activeTool = [...view.steps].reverse().find(step => step.kind === 'tool' && step.state === 'running');
  if (activeTool) return `<i>▸ ${escapeHtml(activeTool.title || '正在执行工具…')}</i>`;
  if (view.status === 'waiting') return '<i>等待你的确认…</i>';
  if (view.status === 'queued') return '<i>排队中…</i>';
  return '<i>思考中…</i>';
}

/** Builds a streaming preview (single Telegram message, safely capped). */
export function renderTurnStreamHtml(view: TurnView): string {
  const blocks: string[] = [];
  if (view.card.header && view.title) blocks.push(`<b>${escapeHtml(view.title)}</b>`);
  if (view.source === 'other-client' && view.prompt) {
    blocks.push(`<blockquote><i>来自其他端</i>\n${escapeHtml(truncate(view.prompt, MAX_PROMPT_CHARS))}</blockquote>`);
  }
  if (view.card.process && view.steps.length) {
    const process = renderProcess(view.steps, false);
    if (process) blocks.push(process);
  }
  if (view.answer.trim()) {
    const answerBlocks = markdownToHtmlBlocks(view.answer);
    const full = [...blocks, ...answerBlocks];
    const pages = packHtmlBlocks(full, TELEGRAM_MAX_VISIBLE);
    if (pages.length === 1) return pages[0]!;
    // Stream preview keeps header/context + latest tail so the user watches live generation.
    const prefix = blocks.join('\n\n');
    const budget = Math.max(400, TELEGRAM_MAX_VISIBLE - visibleLength(prefix) - 40);
    const tail = view.answer.trim().slice(-budget);
    return [prefix, `<i>…（流式预览，完成后发送全文）</i>`, escapeHtml(tail)].filter(Boolean).join('\n\n');
  }
  if (!blocks.length) return runningStatusLine(view);
  blocks.push(runningStatusLine(view));
  return packHtmlBlocks(blocks, TELEGRAM_MAX_VISIBLE)[0] ?? runningStatusLine(view);
}

/** Builds the final persisted Telegram messages for a completed/failed/cancelled turn. */
export function renderTurnFinalPages(view: TurnView): string[] {
  const blocks: string[] = [];
  if (view.card.header && view.title) blocks.push(`<b>${escapeHtml(view.title)}</b>`);
  if (view.source === 'other-client' && view.prompt) {
    blocks.push(`<blockquote><i>来自其他端</i>\n${escapeHtml(truncate(view.prompt, MAX_PROMPT_CHARS))}</blockquote>`);
  }
  if (view.card.process && view.steps.length) {
    const process = renderProcess(view.steps, true);
    if (process) blocks.push(process);
  }
  if (view.answer.trim()) {
    blocks.push(...markdownToHtmlBlocks(view.answer));
  }
  if (view.error) {
    blocks.push(`<blockquote><b>出错</b>\n${escapeHtml(view.error)}</blockquote>`);
  } else if (view.status === 'cancelled' || view.status === 'interrupted') {
    blocks.push(view.status === 'cancelled' ? '<i>已取消</i>' : '<i>已中断</i>');
  } else if (!view.answer.trim() && !view.steps.length) {
    blocks.push('<i>已完成</i>');
  }
  const footer = renderFooter(view.footer, view.card.footer);
  if (footer) blocks.push(footer);
  return packHtmlBlocks(blocks, TELEGRAM_MAX_VISIBLE);
}

const CONFIRM_PREFIXES = ['已绑定', '已开始', '已请求', '已切换', '项目已切换', '这个群'];

/** Formats short command notices, `/status` key-value summaries, and error notices consistently. */
export function renderNoticePages(markdown: string): string[] {
  const trimmed = markdown.trim();
  if (!trimmed) return ['<i>（空消息）</i>'];

  // Error replies (`没有发出去：…`) render as a clear quote block.
  const failed = /^没有发出去[：:]\s*([\s\S]+)$/.exec(trimmed);
  if (failed) {
    return [`<blockquote><b>发送失败</b>\n${escapeHtml(failed[1]!.trim())}</blockquote>`];
  }

  // Structured multi-line status summary (`项目：…\n会话：…\n状态：…`).
  const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.every(line => /^[\u4e00-\u9fa5A-Za-z]{1,6}：/.test(line) || line.startsWith('整群') || line.startsWith('按话题'))) {
    const formatted = lines.map(line => {
      const match = /^([^：]+)：\s*(.*)$/.exec(line);
      if (!match) return `<i>${escapeHtml(line)}</i>`;
      const [, key, value] = match;
      const renderedValue = key === '模型' || key === '项目'
        ? `<code>${escapeHtml(value)}</code>`
        : escapeHtml(value);
      return `<b>${escapeHtml(key!)}</b>  ${renderedValue}`;
    });
    return [`<b>状态</b>\n${formatted.join('\n')}`];
  }

  // Single-line confirmations get a subtle checkmark without adding extra copy.
  if (lines.length === 1 && CONFIRM_PREFIXES.some(prefix => trimmed.startsWith(prefix))) {
    return [`✓ ${escapeHtml(trimmed)}`];
  }

  const pages = packHtmlBlocks(markdownToHtmlBlocks(trimmed), TELEGRAM_MAX_VISIBLE);
  return pages.length ? pages : [escapeHtml(trimmed)];
}

/** Strips HTML to plain text as a fallback if Telegram rejects HTML entity parsing. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .slice(0, 4096);
}
