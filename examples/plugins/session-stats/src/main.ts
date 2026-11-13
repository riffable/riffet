// A sidebar view that reads the open conversation through the message bridge: turn count, total and median
// turn duration, and the tools of the last turn. Plain DOM, no framework; spacing, radius and type come from the
// host's base stylesheet (`--riffet-*` properties, PLUGIN_BASE_STYLE in packages/plugin-web). `build.mjs` bundles it with the
// bridge client into `web/index.js`, which is the package's web entry.
import { connect, type BridgeConnection } from '@riffet/plugin-web/bridge-client';

const messages = {
  'zh-Hans': { turns: '轮次', total: '总耗时', median: '中位耗时', last: '最近一轮的工具', running: '进行中', none: '没有工具调用', empty: '没有打开的会话' },
  en: { turns: 'Turns', total: 'Total time', median: 'Median turn', last: 'Last turn tools', running: 'Running', none: 'No tool calls', empty: 'No open conversation' },
};
type Messages = typeof messages.en;
const pick = (locale: string): Messages => (locale.toLowerCase().startsWith('zh') ? messages['zh-Hans'] : messages.en);

const style = document.createElement('style');
style.textContent = `
  body { padding: var(--riffet-space-3); }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--riffet-space-2); }
  .cell { background: var(--bg-subtle); border: var(--riffet-border-width) solid var(--line); border-radius: var(--riffet-radius-container); padding: var(--riffet-space-2) var(--riffet-space-3); }
  .label { color: var(--fg-3); font-size: var(--riffet-text-small); line-height: var(--riffet-leading-small); }
  .value { color: var(--fg); font-size: var(--riffet-text-reading); line-height: var(--riffet-leading-reading); font-weight: 500; font-variant-numeric: tabular-nums; }
  h2 { color: var(--fg-3); font-size: var(--riffet-text-small); line-height: var(--riffet-leading-small); font-weight: 500; margin: var(--riffet-space-4) 0 var(--riffet-space-2); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; justify-content: space-between; padding: var(--riffet-space-1) 0; border-bottom: var(--riffet-border-width) solid var(--line-soft); }
  li span:last-child { color: var(--fg-3); font-variant-numeric: tabular-nums; }
  .muted { color: var(--fg-3); }
`;
document.head.append(style);

interface Turn { startPos: number; rows: number; status: string; at: string; endedAt?: string }
interface ToolRow { kind: string; event?: { data?: Record<string, unknown> } }

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const name = (row: ToolRow): string => {
  const data = row.event?.data ?? {};
  const value = data.toolName ?? data.name ?? data.title;
  return typeof value === 'string' && value ? value.slice(0, 60) : 'tool';
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function render(bridge: BridgeConnection, root: HTMLElement): Promise<void> {
  const text = pick(bridge.context.locale);
  const sessionId = bridge.context.sessionId;
  if (!sessionId) { root.replaceChildren(element('p', text.empty, 'muted')); return; }
  const { turns } = await bridge.call('sessions.outline', { sessionId }) as { turns: Turn[] };
  const durations = turns.filter((turn) => turn.endedAt).map((turn) => Date.parse(turn.endedAt!) - Date.parse(turn.at)).filter((ms) => ms >= 0);
  const last = turns.at(-1);
  const counts = new Map<string, number>();
  if (last) {
    const page = await bridge.call('sessions.timeline', { sessionId, from: last.startPos, rows: Math.min(Math.max(last.rows, 1), 200) });
    for (const row of page.rows as unknown as ToolRow[]) if (row.kind === 'tool') counts.set(name(row), (counts.get(name(row)) ?? 0) + 1);
  }

  const grid = element('div', undefined, 'grid');
  for (const [label, value] of [[text.turns, String(turns.length)], [text.total, duration(durations.reduce((sum, ms) => sum + ms, 0))], [text.median, duration(median(durations))]] as const) {
    const cell = element('div', undefined, 'cell');
    cell.append(element('div', label, 'label'), element('div', value, 'value'));
    grid.append(cell);
  }
  const heading = element('h2', last && !last.endedAt ? `${text.last} · ${text.running}` : text.last);
  const list = element('ul');
  if (counts.size) for (const [tool, count] of counts) { const item = element('li'); item.append(element('span', tool), element('span', String(count))); list.append(item); }
  else list.append(element('li', text.none, 'muted'));
  root.replaceChildren(grid, heading, list);
}

const root = document.getElementById('root')!;
connect({ requiredMethods: ['sessions.outline', 'sessions.timeline'] }).then((bridge) => {
  let busy = false;
  const refresh = () => {
    if (busy || !bridge.context.visible) return;
    busy = true;
    render(bridge, root).catch(() => undefined).finally(() => { busy = false; });
  };
  refresh();
  // The host tells the view when it is shown or hidden; reading again on show keeps it current without polling a hidden panel.
  bridge.on('context', refresh);
  bridge.on('data', refresh);
  setInterval(refresh, 10_000);
}, (error: unknown) => root.replaceChildren(element('p', String(error), 'muted')));
