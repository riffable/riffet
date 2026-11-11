import { useEffect, useRef, useState } from 'react';
import type { CapabilityReport, CursorCliSettings, ModelInfo } from '@contracts';
import { Button, Icon, Input, ModelField, SettingsGroup as Group, SettingsRow as Row, Spinner, StatusDot, Switch, isUnavailable, useMessages, usePluginHost, useSettings, type UnavailableInfo, type ViewProps } from '@riffet/plugin-web';
import { cliSettingsPatch, hasSeparateAgentEndpoint, normalizeCliSettings, updateGateway } from './cliSettings';
import { catalogs } from './messages';
import { Unavailable } from './Unavailable';

/** Cursor 提供商: where the CLI connects, and the model new sessions start with, saved together from one bar. */
export default function ProviderPage({ context }: ViewProps) {
  const m = useMessages(catalogs);
  const { notify, request, settings: settingsService, settingsPage } = usePluginHost();
  const settings = useSettings();
  const [draft, setDraft] = useState<CursorCliSettings>(() => settings.cursorCli ?? {});
  const baseline = useRef(settings.cursorCli);
  const [separateAgentEndpoint, setSeparateAgentEndpoint] = useState(() => hasSeparateAgentEndpoint(settings.cursorCli));
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [defaultModel, setDefaultModel] = useState(settings.defaultModel ?? '');
  const modelBaseline = useRef(settings.defaultModel ?? '');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [fallbackIds, setFallbackIds] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState<UnavailableInfo>();

  // A read that fails for any reason but Cursor being off leaves the list as it was.
  const loadModels = () => {
    request.get<ModelInfo[]>('/api/cursor/models', { signal: context.signal }).then(setModels).catch((error) => {
      const off = isUnavailable(error);
      if (off && !context.signal.aborted) setUnavailable(off);
    });
  };
  useEffect(() => {
    loadModels();
    request.get<CapabilityReport>('/api/cursor/capabilities', { signal: context.signal }).then((report) => setFallbackIds(report.models)).catch((error) => {
      const off = isUnavailable(error);
      if (off && !context.signal.aborted) setUnavailable(off);
    });
  }, []);

  useEffect(() => {
    const previous = modelBaseline.current;
    const saved = settings.defaultModel ?? '';
    setDefaultModel((current) => current === previous ? saved : current);
    modelBaseline.current = saved;
  }, [settings.defaultModel]);
  const modelDirty = defaultModel !== (settings.defaultModel ?? '');
  const dirty = modelDirty || JSON.stringify(normalizeCliSettings(draft)) !== JSON.stringify(normalizeCliSettings(settings.cursorCli)) || apiKeyDraft.length > 0 || clearApiKey;

  useEffect(() => {
    if (JSON.stringify(normalizeCliSettings(draft)) === JSON.stringify(normalizeCliSettings(baseline.current))) {
      setDraft(settings.cursorCli ?? {});
      if (JSON.stringify(normalizeCliSettings(settings.cursorCli)) !== JSON.stringify(normalizeCliSettings(baseline.current))) setSeparateAgentEndpoint(hasSeparateAgentEndpoint(settings.cursorCli));
    }
    baseline.current = settings.cursorCli;
  }, [settings.cursorCli]);
  useEffect(() => { settingsPage.setDirty(dirty); }, [dirty, settingsPage]);
  useEffect(() => { settingsPage.setBusy(savingSettings); }, [savingSettings, settingsPage]);

  const saveSettings = async () => {
    if (savingSettings || !dirty) return;
    const changed = cliSettingsPatch(draft, settings.cursorCli);
    const cursorCli = {
      ...changed,
      ...(apiKeyDraft.length > 0 ? { apiKey: apiKeyDraft } : clearApiKey ? { apiKey: null } : {}),
    };
    const connectionChanged = Object.keys(cursorCli).length > 0;
    setSavingSettings(true);
    try {
      // The server keeps credentials separately and rejects a mixed cursorCli/general PATCH.
      // Publish each successful receipt so a later failure never rolls back an accepted edit.
      if (connectionChanged) {
        const saved = await settingsService.update({ cursorCli });
        setDraft(saved.cursorCli ?? {});
        setApiKeyDraft('');
        setClearApiKey(false);
        setSeparateAgentEndpoint(hasSeparateAgentEndpoint(saved.cursorCli));
      }
      if (modelDirty) {
        const saved = await settingsService.update({ defaultModel });
        setDefaultModel(saved.defaultModel ?? '');
      }
      notify.success(connectionChanged ? m.savedConnection : m.savedModel);
    } catch (error) {
      const off = isUnavailable(error);
      if (off) setUnavailable(off);
      notify.error(undefined, m.saveIncomplete);
    } finally { setSavingSettings(false); }
  };

  const gatewayDescription = separateAgentEndpoint
    ? (draft.agentEndpoint?.trim() ? m.gatewayKeepsAgentEndpoint : m.gatewayKeepsAgentDefault)
    : m.gatewayForBoth;

  return (
    // The page fills the panel, so its save sits at the bottom even when the page is short.
    <div className="flex min-h-full flex-col gap-6">
      {unavailable && <Unavailable info={unavailable} />}
      <p className="text-xs text-fg-3">{m.savedOnServer}</p>
      <Group title={m.connection}>
        <Row title={m.gateway} description={gatewayDescription}>
          <Input aria-label={m.gatewayLabel} disabled={savingSettings} className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={draft.apiEndpoint ?? ''} placeholder={m.gatewayPlaceholder} onChange={(event) => setDraft((current) => updateGateway(current, event.target.value, separateAgentEndpoint))} />
        </Row>
        <Row title={m.apiKey} description={m.apiKeyHidden}>
          <div className="flex w-64 flex-col gap-2 max-md:w-full">
            <Input aria-label={m.apiKeyLabel} type="password" autoComplete="new-password" disabled={savingSettings} className="h-8 font-mono max-md:h-11" value={apiKeyDraft} placeholder={m.apiKeyPlaceholder} onChange={(event) => { setApiKeyDraft(event.target.value); setClearApiKey(false); }} />
            <div className="flex items-center justify-between gap-2">
              {/* A saved key is the normal state; only a missing one is spelled out. */}
              <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">{!settings.cursorCli?.hasApiKey && <><StatusDot tone="idle" />{m.noKey}</>}</span>
              {settings.cursorCli?.hasApiKey && <Button size="xs" variant="ghost" disabled={savingSettings} onClick={() => { setApiKeyDraft(''); setClearApiKey((value) => !value); }}>{clearApiKey ? m.undoClear : m.clearKey}</Button>}
            </div>
            {clearApiKey && <span className="text-xs text-warning">{m.clearKeyOnSave}</span>}
          </div>
        </Row>
        <details className="group py-1">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-3 text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
            <Icon name="chevron-right" className="size-4 shrink-0 text-fg-3 transition-transform group-open:rotate-90" />
            {m.advanced}
          </summary>
          <div className="edge-t [&>*+*]:edge-t">
            <Row title={m.executable}>
              <Input aria-label={m.executableLabel} disabled={savingSettings} className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={draft.executable ?? ''} placeholder={m.executablePlaceholder} onChange={(event) => setDraft((current) => ({ ...current, executable: event.target.value }))} />
            </Row>
            <Row title={m.configDir} description={m.configDirHint}>
              <Input aria-label={m.configDir} disabled={savingSettings} className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={draft.configDir ?? ''} placeholder={m.configDirPlaceholder} onChange={(event) => setDraft((current) => ({ ...current, configDir: event.target.value }))} />
            </Row>
            <Row title={m.separateAgentEndpoint} description={m.separateAgentEndpointHint}>
              <Switch aria-label={m.separateAgentEndpoint} disabled={savingSettings} checked={separateAgentEndpoint} onCheckedChange={(value) => {
                setSeparateAgentEndpoint(value);
                if (!value) setDraft((current) => ({ ...current, agentEndpoint: current.apiEndpoint ?? '' }));
              }} />
            </Row>
            {separateAgentEndpoint && <Row title={m.agentEndpoint}>
              <Input aria-label={m.agentEndpointLabel} disabled={savingSettings} className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={draft.agentEndpoint ?? ''} placeholder={m.agentEndpointPlaceholder} onChange={(event) => setDraft((current) => ({ ...current, agentEndpoint: event.target.value }))} />
            </Row>}
            <Row title={m.disableAutoUpdate}>
              <Switch aria-label={m.disableAutoUpdateLabel} disabled={savingSettings} checked={draft.disableAutoUpdate === true} onCheckedChange={(value) => setDraft((current) => ({ ...current, disableAutoUpdate: value }))} />
            </Row>
          </div>
        </details>
      </Group>
      <Group title={m.newSessionModel}>
        <Row title={m.defaultModel} description={m.defaultModelHint}>
          <ModelField value={defaultModel} models={models} fallbackIds={fallbackIds} placeholder={m.defaultModelPlaceholder} disabled={savingSettings} onChange={setDefaultModel} onOpen={loadModels} />
        </Row>
      </Group>
      {/* One save for the page: both groups go to the server in the same step. */}
      {dirty && <div className="sticky bottom-0 -mx-6 -mb-5 mt-auto flex justify-end edge-t bg-elevated px-6 py-3 max-md:-mx-4 max-md:px-4">
        <Button size="sm" variant="primary" className="max-md:h-11" disabled={savingSettings} onClick={() => void saveSettings()}>{savingSettings ? <Spinner className="text-current" /> : <Icon name="save" />}{m.save}</Button>
      </div>}
    </div>
  );
}
