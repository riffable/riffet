import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { REMOTE_SPEECH_RECOGNIZER, type AppSettings, type PluginDescriptor, type VoiceInputSettingsUpdate } from '@contracts';
import { Input, Select } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { localizedText } from '@/lib/plugins';
import { errorMessage } from '@/lib/utils';
import { SettingsGroup as Group, SettingsLinkRow, SettingsRow as Row } from './SettingsLayout';

const OFF = 'off';
const LANGUAGE_AUTO = 'auto';
/** Each language in its own name, whatever the interface language. */
const LANGUAGES = [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]; // i18n-ignore

/** A text field saved when it loses focus or Enter is pressed, if it changed. */
function CommitInput({ label, value, onCommit, disabled, type, placeholder }: { label: string; value: string; onCommit: (value: string) => void; disabled?: boolean; type?: 'password' | 'url'; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft.trim() !== value) onCommit(draft.trim()); };
  return <Input aria-label={label} type={type} autoComplete={type === 'password' ? 'new-password' : 'off'} spellCheck={false} placeholder={placeholder} disabled={disabled}
    className="h-8 w-72 font-mono max-md:h-11 max-md:w-full" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />;
}

/** 语音输入 (docs/VOICE.md §6): the recognizer, and the remote service's address, model and key. */
export function VoiceInputSection({ settings, onSaved, onError, onOpenPlugin }: {
  settings: AppSettings;
  onSaved: (settings: AppSettings, patch: Partial<AppSettings>) => void;
  onError: (message: string) => void;
  onOpenPlugin: (pluginId: string) => void;
}) {
  const { t, i18n } = useLingui();
  const [busy, setBusy] = useState(false);
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void api.plugins(controller.signal).then((answer) => setPlugins(answer.integrations.filter((plugin) => plugin.declared?.speechRecognizer)), () => {});
    return () => controller.abort();
  }, []);
  const voice = settings.voiceInput ?? {};
  const recognizer = voice.recognizer ?? OFF;
  const plugin = plugins.find((item) => item.id === recognizer);
  const persist = async (voiceInput: VoiceInputSettingsUpdate) => {
    if (busy) return;
    setBusy(true);
    try { const saved = await api.updateSettings({ voiceInput }); onSaved(saved, { voiceInput: saved.voiceInput }); }
    catch (error) { onError(errorMessage(error, t`无法保存语音输入设置`)); }
    finally { setBusy(false); }
  };
  const choose = async (next: string) => {
    if (next === recognizer) return;
    await persist({ recognizer: next === OFF ? null : next });
    const chosen = plugins.find((item) => item.id === next);
    // Choosing a plugin's recognizer is turning it on; its models are installed on its page.
    if (chosen && !chosen.enabled) {
      try { const updated = await api.updatePlugin(chosen.id, { enablement: 'on' }); setPlugins((current) => current.map((item) => item.id === updated.id ? updated : item)); }
      catch (error) { onError(errorMessage(error, t`无法开启插件`)); }
    }
  };
  const options = [
    { value: OFF, label: t({ message: '关闭', context: 'option-off' }) },
    { value: REMOTE_SPEECH_RECOGNIZER, label: t`语音识别服务` },
    ...plugins.map((item) => ({ value: item.id, label: localizedText(item.declared?.speechRecognizer?.title, [i18n.locale]) ?? item.name })),
  ];
  return <Group title={t`语音输入`}>
    <Row title={t`识别方式`}>
      <Select label={t`识别方式`} value={recognizer} options={options} disabled={busy} onChange={(next) => void choose(next)} />
    </Row>
    {recognizer === REMOTE_SPEECH_RECOGNIZER && <>
      <Row title={t`服务地址`} description={t`录音会发送到这个地址`}>
        <CommitInput label={t`服务地址`} type="url" placeholder="https://api.openai.com/v1" value={voice.remote?.baseUrl ?? ''} disabled={busy} onCommit={(value) => void persist({ remote: { baseUrl: value || null } })} />
      </Row>
      <Row title={t`模型`}>
        <CommitInput label={t`模型`} placeholder="gpt-4o-transcribe" value={voice.remote?.model ?? ''} disabled={busy} onCommit={(value) => void persist({ remote: { model: value || null } })} />
      </Row>
      <Row title="API Key">
        <CommitInput label="API Key" type="password" placeholder={voice.remote?.hasApiKey ? t`已保存，输入新 Key 替换` : undefined} value="" disabled={busy} onCommit={(value) => { if (value) void persist({ remote: { apiKey: value } }); }} />
      </Row>
    </>}
    {plugin && <SettingsLinkRow title={t`本机模型`} value={plugin.status && plugin.status.state !== 'ready' ? t`未下载模型` : undefined} onClick={() => onOpenPlugin(plugin.id)} />}
    {recognizer !== OFF && <Row title={t`语言`}>
      <Select label={t`语言`} value={voice.language ?? LANGUAGE_AUTO} disabled={busy} onChange={(next) => void persist({ language: next === LANGUAGE_AUTO ? null : next })}
        options={[{ value: LANGUAGE_AUTO, label: t`自动` }, ...LANGUAGES]} />
    </Row>}
  </Group>;
}
