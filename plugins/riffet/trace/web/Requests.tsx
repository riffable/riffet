import { useMemo, useState, type ReactNode } from 'react';
import type { TraceContextMessage, TracePrompt, TraceRequest, TraceToolDefinition } from '@contracts';
import { DiffView, Segmented, Spinner, useMessages } from '@riffet/plugin-web';
import { cn } from './cn';
import type { RequestsState } from './data';
import { formatClock, formatDateTime, formatExact } from './format';
import { IconChevronRight } from './icons';
import { JsonTree, LongString } from './JsonTree';
import { catalogs, type TraceMessages } from './messages';
import type { RequestIndex } from './model';

/*
 * What a model request was sent with (docs/TRACE.md §2.1), from the agent's own records: the prompt (system
 * blocks and tools), the parameters, and the messages it added. Shown inside the inspector of a model request,
 * a turn, or a prompt.
 */

/** The state of the read, or its content once there is some. */
export function RequestsGate({ state, index, children }: { state: RequestsState; index: RequestIndex | undefined; children: (index: RequestIndex) => ReactNode }) {
  const m = useMessages(catalogs);
  if (index && index.data.status === 'ok') return <>{children(index)}</>;
  if (state.loading) return <div className="flex h-8 items-center"><Spinner className="size-4 text-fg-4" /></div>;
  if (state.error) return <p className="text-xs text-danger">{m.loadFailed}: {state.error}</p>;
  const status = index?.data.status;
  if (status && status !== 'ok') return <p className="text-xs text-fg-4">{m.requestsStatus[status]}</p>;
  return null;
}

function Rows({ items }: { items: Array<[string, ReactNode] | false | undefined> }) {
  const shown = items.filter((item): item is [string, ReactNode] => Array.isArray(item) && item[1] !== undefined && item[1] !== '' && item[1] !== null);
  return (
    <dl className="grid grid-cols-[minmax(84px,auto)_1fr] gap-x-3 gap-y-1 text-xs">
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-4">{label}</dt>
          <dd className="min-w-0 select-text wrap-anywhere font-mono text-fg-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A disclosure row: a label line that opens to its content. */
function Disclosure({ title, meta, children, defaultOpen = false }: { title: ReactNode; meta?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full items-center gap-1.5 rounded-sm px-1 text-left text-xs hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <IconChevronRight className={cn('size-3 shrink-0 text-fg-4 transition-transform duration-[var(--duration-fast)]', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate font-mono text-fg-2">{title}</span>
        {meta && <span className="shrink-0 font-mono text-2xs text-fg-4">{meta}</span>}
      </button>
      {open && <div className="pb-2 pl-5 animate-in fade-in-0 duration-[var(--duration-fast)]">{children}</div>}
    </div>
  );
}

function ContextMessage({ message, m }: { message: TraceContextMessage; m: TraceMessages }) {
  const chars = message.chars ?? message.text.length;
  return (
    <Disclosure title={message.label ?? message.text.slice(0, 80)} meta={`${message.role} · ${m.charsCount(chars)}`}>
      {message.omitted ? <p className="text-xs text-fg-4">{m.contextOmitted}</p> : (
        <>
          {message.chars !== undefined && <p className="mb-1 text-xs text-fg-4">{m.truncated}</p>}
          <LongString text={message.text} />
        </>
      )}
    </Disclosure>
  );
}

/** The messages a request added, injected ones each openable, runs of conversation messages as one line. */
export function AddedMessages({ added, index }: { added: ReadonlyArray<string | null>; index: RequestIndex }) {
  const m = useMessages(catalogs);
  const groups: Array<{ id: string } | { conversation: number }> = [];
  for (const id of added) {
    const last = groups.at(-1);
    if (id === null) { if (last && 'conversation' in last) last.conversation += 1; else groups.push({ conversation: 1 }); }
    else groups.push({ id });
  }
  if (!groups.length) return null;
  return (
    <div className="flex flex-col">
      {groups.map((group, position) => {
        if ('conversation' in group) return <p key={`c${position}`} className="flex h-7 items-center px-1 pl-5 text-xs text-fg-4">{m.conversationMessages(group.conversation)}</p>;
        const message = index.data.context[group.id];
        return message ? <ContextMessage key={`${group.id}:${position}`} message={message} m={m} /> : null;
      })}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5">
      <div className="mb-2 flex h-6 items-center gap-2">
        <h3 className="flex-1 text-xs font-medium text-fg-3">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One recorded request: when and how it was sent, its prompt, its parameters and what it added. */
export function RequestDetail({ request, index, onOpenPrompt }: { request: TraceRequest; index: RequestIndex; onOpenPrompt(id: string): void }) {
  const m = useMessages(catalogs);
  const prompt = request.prompt ? index.prompts.get(request.prompt) : undefined;
  const params = request.params ? index.data.params[request.params] : undefined;
  return (
    <>
      <Rows items={[
        [m.sent, formatClock(Date.parse(request.at))],
        [m.model, request.model],
        [m.source, request.source],
        request.messages !== undefined && [m.messages_, formatExact(request.messages)],
        index.data.version !== undefined && [m.version, `${index.data.backendId ?? ''} ${index.data.version}`.trim()],
      ]} />
      {prompt && (
        <Section title={m.prompt_}>
          <button
            type="button"
            onClick={() => onOpenPrompt(prompt.id)}
            className="flex w-full items-center gap-2 rounded-md bg-muted px-2.5 py-2 text-left text-xs hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span className="min-w-0 flex-1 truncate text-fg-2">{prompt.system[0]?.text.trim().split('\n', 1)[0]}</span>
            <span className="shrink-0 font-mono text-fg-4">{m.blocksCount(prompt.system.length)} · {m.toolsCount(prompt.tools.length)}</span>
          </button>
        </Section>
      )}
      {request.added && request.added.length > 0 && (
        <Section title={m.added}><AddedMessages added={request.added} index={index} /></Section>
      )}
      {params && <Section title={index.data.granularity === 'turn' ? m.turnSettings : m.params}><JsonTree value={params} openDepth={1} /></Section>}
    </>
  );
}

function ToolRow({ tool }: { tool: TraceToolDefinition }) {
  const m = useMessages(catalogs);
  return (
    <Disclosure title={tool.group ? `${tool.group} / ${tool.name}` : tool.name} meta={tool.description ? m.charsCount(tool.description.length) : undefined}>
      {tool.description && <LongString text={tool.description} />}
      {tool.schema !== undefined && <div className="mt-2"><p className="mb-1 text-xs text-fg-4">{m.schema}</p><JsonTree value={tool.schema} openDepth={2} /></div>}
    </Disclosure>
  );
}

const toolText = (tool: TraceToolDefinition) => `${tool.description ?? ''}\n${JSON.stringify(tool.schema ?? null)}`;

/** A prompt: its system blocks, its tools, and how it differs from the one before it. */
export function PromptDetail({ prompt, index }: { prompt: TracePrompt; index: RequestIndex }) {
  const m = useMessages(catalogs);
  const position = index.data.prompts.findIndex((item) => item.id === prompt.id);
  const previous = position > 0 ? index.data.prompts[position - 1] : undefined;
  const [tab, setTab] = useState<'system' | 'tools' | 'changes'>('system');
  const changes = useMemo(() => {
    if (!previous) return undefined;
    const before = new Map(previous.tools.map((tool) => [tool.name, tool]));
    const after = new Map(prompt.tools.map((tool) => [tool.name, tool]));
    return {
      added: prompt.tools.filter((tool) => !before.has(tool.name)).map((tool) => tool.name),
      removed: previous.tools.filter((tool) => !after.has(tool.name)).map((tool) => tool.name),
      changed: prompt.tools.filter((tool) => before.has(tool.name) && toolText(before.get(tool.name)!) !== toolText(tool)).map((tool) => tool.name),
      systemBefore: previous.system.map((block) => block.text).join('\n\n'),
      systemAfter: prompt.system.map((block) => block.text).join('\n\n'),
    };
  }, [prompt, previous]);
  const chars = prompt.system.reduce((sum, block) => sum + (block.chars ?? block.text.length), 0);
  return (
    <>
      <Rows items={[
        [m.firstSent, formatDateTime(Date.parse(prompt.at))],
        [m.usedBy, m.requestsCount(index.uses.get(prompt.id) ?? 0)],
        [m.systemPrompt, `${m.blocksCount(prompt.system.length)} · ${m.charsCount(chars)}`],
        [m.tools, String(prompt.tools.length)],
      ]} />
      <div className="mt-4">
        <Segmented
          size="xs"
          value={tab}
          ariaLabel={m.prompt_}
          onChange={(value) => setTab(value as typeof tab)}
          options={[
            { value: 'system', label: m.systemPrompt },
            { value: 'tools', label: `${m.tools} ${prompt.tools.length}` },
            ...(changes ? [{ value: 'changes', label: m.changes }] : []),
          ]}
        />
      </div>
      {tab === 'system' && (
        <div className="mt-3 flex flex-col gap-2">
          {prompt.system.map((block, position) => (
            <div key={position}>
              <p className="mb-1 font-mono text-2xs text-fg-4">{block.role} · {m.charsCount(block.chars ?? block.text.length)}{block.chars !== undefined ? ` · ${m.truncated}` : ''}</p>
              <LongString text={block.text} />
            </div>
          ))}
        </div>
      )}
      {tab === 'tools' && <div className="mt-3 flex flex-col">{prompt.tools.map((tool) => <ToolRow key={`${tool.group ?? ''}/${tool.name}`} tool={tool} />)}</div>}
      {tab === 'changes' && changes && (
        <div className="mt-3 flex flex-col gap-3 text-xs">
          {!changes.added.length && !changes.removed.length && !changes.changed.length && changes.systemBefore === changes.systemAfter && <p className="text-fg-4">{m.sameAsPrevious}</p>}
          <Rows items={[
            changes.added.length > 0 && [m.toolsAdded, changes.added.join(', ')],
            changes.removed.length > 0 && [m.toolsRemoved, changes.removed.join(', ')],
            changes.changed.length > 0 && [m.toolsChanged, changes.changed.join(', ')],
          ]} />
          {changes.systemBefore !== changes.systemAfter && (
            <div>
              <p className="mb-1 text-fg-4">{m.systemPrompt}</p>
              <DiffView path="system" before={changes.systemBefore} after={changes.systemAfter} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
