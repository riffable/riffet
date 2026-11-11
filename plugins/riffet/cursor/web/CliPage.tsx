import { useEffect, useMemo, useState } from 'react';
import type { CapabilityReport, CommandResult, ModelInfo } from '@contracts';
import { Badge, Button, Icon, Input, SettingsGroup as Group, SettingsRow as Row, Spinner, StatusDot, isUnavailable, useMessages, usePluginHost, useProjects, type UnavailableInfo, type ViewProps } from '@riffet/plugin-web';
import { catalogs } from './messages';
import { Unavailable } from './Unavailable';

/** Cursor model names sometimes carry zero-width padding and doubled spaces. */
const cleanLabel = (value: string) => value.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

/** CLI 管理: what the Cursor CLI reports about itself, and a runner for its allow-listed commands. */
export default function CliPage({ context }: ViewProps) {
  const m = useMessages(catalogs);
  const { locale, notify, request, settingsPage } = usePluginHost();
  const project = useProjects().find((item) => item.id === context.projectId);
  const quickCommands = [
    { label: m.status, operation: 'status', args: [] as string[] },
    { label: m.models, operation: 'models', args: [] },
    { label: m.account, operation: 'about', args: [] },
    { label: m.team, operation: 'team', args: [] },
    { label: 'MCP', operation: 'mcp', args: ['list'] },
    { label: m.plugins, operation: 'plugin.marketplace.list', args: [] },
  ];
  const [capabilities, setCapabilities] = useState<CapabilityReport>();
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const [detecting, setDetecting] = useState(true);
  const [unavailable, setUnavailable] = useState<UnavailableInfo>();
  const [operation, setOperation] = useState('status');
  const [args, setArgs] = useState('');
  const [output, setOutput] = useState<CommandResult & { operation: string }>();
  const [running, setRunning] = useState(false);
  useEffect(() => { settingsPage?.setBusy(running); return () => settingsPage?.setBusy(false); }, [running, settingsPage]);
  const [error, setError] = useState('');
  const checked = useMemo(() => capabilities && new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(capabilities.checkedAt)), [capabilities, locale]);

  /** `loud` is the user's own request, which tells them when it fails; the first read on opening does not. */
  const detect = async (loud: boolean) => {
    setDetecting(true);
    try {
      setCapabilities(await request.get<CapabilityReport>('/api/cursor/capabilities', { signal: context.signal }));
      setUnavailable(undefined);
    } catch (reason) {
      const off = isUnavailable(reason);
      if (off) setUnavailable(off);
      else if (loud && !context.signal.aborted) notify.error(reason, m.detectFailed);
    } finally { if (!context.signal.aborted) setDetecting(false); }
  };
  useEffect(() => {
    void detect(false);
    request.get<ModelInfo[]>('/api/cursor/models', { signal: context.signal }).then(setCatalog).catch((reason) => {
      const off = isUnavailable(reason);
      if (off && !context.signal.aborted) setUnavailable(off);
    });
  }, []);

  const run = async (op = operation, rawArgs = args) => {
    let list: string[];
    const trimmed = rawArgs.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error();
        list = parsed as string[];
      } catch { setError(m.argsInvalid); return; }
    } else list = trimmed ? trimmed.split(/\s+/) : [];
    setError(''); setRunning(true);
    try {
      const result = await request.post<CommandResult>('/api/cursor/command', { operation: op.trim(), args: list, ...(project ? { projectId: project.id } : {}) });
      setOutput({ operation: [op, ...list].join(' '), ...result });
    } catch (reason) {
      const off = isUnavailable(reason);
      if (off) setUnavailable(off);
      else setError(notify.errorText(reason, m.commandFailed));
    } finally { setRunning(false); }
  };

  const custom = capabilities?.authMessage?.startsWith('Custom Cursor provider') === true;
  const detected = catalog.length ? catalog.map((model) => ({ id: model.value, label: cleanLabel(model.name) })) : (capabilities?.models ?? []).map((id) => ({ id, label: id }));
  return (
    <div className="flex flex-col gap-6">
      {unavailable && <Unavailable info={unavailable} />}
      <Group title={m.environment} action={<Button size="xs" variant="ghost" disabled={detecting} onClick={() => void detect(true)}>{detecting ? <Spinner /> : <Icon name="refresh-cw" />}{m.detectAgain}</Button>}>
        {capabilities ? <>
          <Row title={m.cliVersion}><span className="text-sm text-fg-2">{capabilities.cliVersion ?? m.unknown}</span></Row>
          <Row title={m.cliPath}><span className="break-all font-mono text-xs text-fg-2">{capabilities.cliPath}</span></Row>
          <Row title={custom ? m.customService : m.cliAccount}><span className="inline-flex items-center gap-1.5 text-sm text-fg-2"><StatusDot tone={capabilities.authenticated ? 'success' : 'warning'} />{capabilities.authenticated ? (custom ? m.connected : m.signedIn) : m.notSignedIn}</span></Row>
          <Row title={m.persistence}><span className="text-sm text-fg-2">{capabilities.nativePersistence}</span></Row>
          <Row title={m.checkedAt}><span className="text-xs text-fg-3">{checked}</span></Row>
        </> : !detecting && <p className="py-4 text-xs text-fg-3">{m.notDetected}</p>}
      </Group>
      {capabilities && capabilities.warnings.length > 0 && <div className="flex flex-col gap-2">
        {capabilities.warnings.map((warning, index) => <p key={index} className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning"><Icon name="circle-alert" className="mt-px size-3.5 shrink-0" />{warning}</p>)}
      </div>}
      {detected.length > 0 && <Group title={m.detectedModels}>
        <div className="flex flex-wrap gap-1.5 py-3">{detected.map((model) => <span key={model.id} title={model.id} className="rounded-md bg-muted px-2 py-0.5 text-xs text-fg-2">{model.label}</span>)}</div>
      </Group>}
      {capabilities && <details className="py-1"><summary className="cursor-pointer text-xs text-fg-3">{m.fullReport}</summary><pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-subtle p-3 font-mono text-xs text-fg-2">{JSON.stringify(capabilities, null, 2)}</pre></details>}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-fg-3">{m.runCommand}</h3>
        <div className="flex flex-wrap gap-1.5">
          {quickCommands.map((item) => <Button key={item.label} size="xs" className="max-md:h-9" onClick={() => { setOperation(item.operation); setArgs(item.args.join(' ')); void run(item.operation, item.args.join(' ')); }}>{item.label}</Button>)}
        </div>
        <form className="flex gap-2 max-md:flex-col" onSubmit={(event) => { event.preventDefault(); void run(); }}>
          <Input className="w-40 font-mono max-md:h-11 max-md:w-full" value={operation} onChange={(event) => setOperation(event.target.value)} placeholder={m.command} aria-label={m.command} />
          <Input className="flex-1 font-mono max-md:h-11" value={args} onChange={(event) => setArgs(event.target.value)} placeholder={m.argsPlaceholder} aria-label={m.args} />
          <Button type="submit" variant="primary" className="max-md:h-11" disabled={!operation.trim() || running}>{running ? <Spinner className="text-current" /> : <Icon name="play" />}{m.run}</Button>
        </form>
        <p className="text-xs text-fg-3">{m.commandScope(project?.name)}</p>
        {error && <p className="text-xs text-danger">{error}</p>}
        {output && (
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="flex h-8 items-center gap-2 edge-b bg-subtle px-3 text-xs">
              <span className="min-w-0 truncate font-mono text-fg-2">$ agent {output.operation}</span>
              <Badge tone={output.code === 0 ? 'success' : 'danger'} className="ml-auto">{m.exitCode(output.code)}</Badge>
              {output.timedOut && <Badge tone="warning">{m.timedOut}</Badge>}
              {output.truncated && <Badge>{m.truncated}</Badge>}
            </div>
            <pre className="max-h-72 overflow-auto p-3 font-mono text-xs leading-[18px] whitespace-pre-wrap text-fg">{output.stdout || (!output.stderr ? m.noOutput : '')}{output.stderr && <span className="text-danger">{output.stderr}</span>}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
