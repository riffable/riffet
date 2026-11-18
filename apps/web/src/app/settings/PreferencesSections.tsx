import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { APPEARANCE_DEFAULT, CODE_THEME_AUTO, AGENT_PROCESS_BUDGET, isKnownCodeThemeId, parseCodeThemeSelection, type AppSettings, type AppearanceCatalog } from '@contracts';
import { IconCheck, IconFolderOpen, IconLogOut, IconPencilLine, IconPlus, IconRotateCcw, IconSave } from '@/components/icons';
import { IconQrCode } from '@/components/icons-base';
import { AppIconTile } from '@/components/BrandMark';
import { ThemeSwatch } from '@/components/theme-swatch';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Select, Input, Segmented, Switch } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { appIcons, setAppIcon, useAppIcon } from '@/lib/app-icon';
import { palettesOf, selectAppearanceItem, selectPreset, syncAppearance, useAppearance } from '@/lib/appearance';
import { BUILTIN_CODE_THEMES } from '@/lib/code-themes.generated';
import { defaultDisplaySettings, MAX_TERMINAL_PADDING_HORIZONTAL, MAX_TERMINAL_PADDING_VERTICAL, setDisplaySettings, terminalFontSizes, useDisplaySettings, type Density, type TextSize } from '@/lib/display-settings';
import { cachedHighlight, highlightCode } from '@/lib/highlight';
import { localeOptions, setLocale, useLocale, type CatalogLocale } from '@/lib/i18n';
import { setThemeId, setThemeMode, useTheme, type ThemeMode } from '@/lib/theme';
import { localizedText } from '@/lib/plugins';
import { isCustomThemeId, syncThemeLibrary, useCurrentThemeLibrary, useThemeOptions } from '@/lib/theme-library';
import { type ThemeDefinition } from '@/lib/themes';
import { toast } from '@/lib/toast';
import { cn, errorMessage } from '@/lib/utils';
import { textOf } from '@/lib/errors';
import { readEnterKeyBehavior, type EnterKeyBehavior } from '../session/composerKeyboard';
import { readComposerRunningBehavior, type ComposerRunningBehavior } from '../session/composerRunning';
import { PermissionGlyph, setPermissionIconStyle, usePermissionIconStyle, type PermissionIconStyle, type PermissionTier } from '../session/ApprovalPicker';
import { SettingsGroup as Group, SettingsLinkRow, SettingsRow as Row } from './SettingsLayout';
import { DirectoryPicker } from '../DirectoryPicker';
import { useLists } from '../state/stores';
import { ConnectServerDialog, PairDeviceDialog } from './PairingDialogs';
import { PairingQrScanner } from '@/components/PairingQrScanner';
import { useMediaQuery } from '@/lib/use-media-query';
import { UpdateSection } from './UpdateSection';

const ThemeEditor = lazy(() => import('./ThemeEditor').then((module) => ({ default: module.ThemeEditor })));
type ThemeEditorTarget = import('./ThemeEditor').ThemeEditorTarget;

interface ServerSettingsProps {
  settings: AppSettings;
  onSaved: (settings: AppSettings, patch: Partial<AppSettings>) => void;
  onError: (message: string) => void;
}

/**
 * One palette in the gallery. The swatch is the shared `ThemeSwatch`, which paints the real theme
 * rather than a copied colour — see that component for why that is possible. A custom theme also
 * carries its edit button, beside the card rather than inside it so both stay real buttons.
 */
function ThemeCard({ theme, selected, onSelect = () => setThemeId(theme.id), onEdit }: { theme: Pick<ThemeDefinition, 'id' | 'name'>; selected: boolean; onSelect?: () => void; onEdit?: () => void }) {
  const { t } = useLingui();
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          'flex min-h-11 w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors',
          selected ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover',
          onEdit && 'pr-10',
        )}
      >
        <ThemeSwatch id={theme.id} />
        <span className="min-w-0 truncate text-sm font-medium text-fg">{theme.name}</span>
        {selected && <IconCheck className="ml-auto size-4 shrink-0 text-accent" />}
      </button>
      {onEdit && (
        <Tip label={t`编辑主题`}>
          <Button size="icon-sm" variant="quiet" aria-label={t`编辑“${theme.name}”`} className="absolute top-1/2 right-1.5 -translate-y-1/2" onClick={onEdit}><IconPencilLine /></Button>
        </Tip>
      )}
    </div>
  );
}

/** The choices of one appearance slot, led by the host's own. */
function AppearanceChoice({ label, items, value, onChange }: { label: string; items: ReadonlyArray<{ id: string; title: Record<string, string> }>; value: string | undefined; onChange: (id: string) => void }) {
  const { t } = useLingui();
  return <Select<string>
    label={label} className="w-48 max-md:w-full" value={value ?? APPEARANCE_DEFAULT} onChange={onChange}
    options={[{ value: APPEARANCE_DEFAULT, label: t`默认` }, ...items.map((item) => ({ value: item.id, label: localizedText(item.title) ?? item.id }))]}
  />;
}

/** The catalog's fonts of one role, for the typography page. */
const fontsOf = (catalog: AppearanceCatalog | undefined, role: 'ui' | 'mono') => (catalog?.fonts ?? []).filter((font) => font.role === role);

function themeCredits(themes: readonly ThemeDefinition[]): string {
  const credited = themes.filter((theme) => theme.credit).map((theme) => `${theme.name} (${theme.credit})`);
  return new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(credited);
}

const CODE_PREVIEW_SNIPPET = `// Syntax preview
@tagged("api")
async function loadConfig(limit = 42): Promise<Config> {
  const mode = true;
  return { name: "riffet", count: limit };
}`;

function CodeThemePreview() {
  const [html, setHtml] = useState<string | undefined>(() => cachedHighlight(CODE_PREVIEW_SNIPPET, 'typescript'));
  useEffect(() => {
    let active = true;
    if (html === undefined) {
      void highlightCode(CODE_PREVIEW_SNIPPET, 'typescript').then((result) => {
        if (active && result !== undefined) setHtml(result);
      });
    }
    return () => { active = false; };
  }, [html]);
  return (
    <div className="py-3.5">
      <pre className="overflow-x-auto rounded-lg bg-subtle px-3.5 py-3 font-mono text-xs leading-5 text-fg">
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{CODE_PREVIEW_SNIPPET}</code>}
      </pre>
    </div>
  );
}

function PermissionIconPreview({ style }: { style: PermissionIconStyle }) {
  const { t } = useLingui();
  const items: ReadonlyArray<{ tier: PermissionTier; label: string }> = [
    { tier: 'read', label: t`只读` },
    { tier: 'ask', label: t`每次询问` },
    { tier: 'default', label: t`默认` },
    { tier: 'workspace', label: t`工作区` },
    { tier: 'auto', label: t`自动审查` },
    { tier: 'deny', label: t`拒绝` },
    { tier: 'full', label: t`全部放行` },
  ];
  return (
    <div className="py-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-subtle px-3.5 py-2.5 text-xs text-fg-2">
        {items.map(({ tier, label }) => (
          <span key={tier} className={cn('inline-flex items-center gap-1.5', tier === 'full' && 'text-warning')}>
            <PermissionGlyph tier={tier} iconStyle={style} className="size-4" />
            <span>{label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 主题: light or dark, the palette, and the shared library of custom themes. */
export function ThemeSection() {
  const { t } = useLingui();
  const { mode, themeId, paletteKey } = useTheme();
  const display = useDisplaySettings();
  const { catalog, selection, effective } = useAppearance();
  const plugins = palettesOf(catalog);
  // Built-ins plus whatever the shared library holds; a custom theme edited on another device
  // appears here without a reload.
  const themes = useThemeOptions();
  const customSyntaxThemes = useCurrentThemeLibrary().themes.filter((entry) => Boolean(entry.syntax));
  const selectedCustomSyntax = customSyntaxThemes.some((entry) => entry.id === display.codeTheme);
  const effectiveCodeValue = display.codeTheme.startsWith('custom-') && !selectedCustomSyntax ? CODE_THEME_AUTO : display.codeTheme;
  const credits = themeCredits(themes);
  const [editorOpen, setEditorOpen] = useState(false);
  /** Kept after closing, so the dialog animates out on the theme it showed. Null until first opened, which loads the editor. */
  const [editorTarget, setEditorTarget] = useState<ThemeEditorTarget | null>(null);
  const openEditor = (target: ThemeEditorTarget) => { setEditorTarget(target); setEditorOpen(true); };
  // Opening the picker is a natural moment to ask whether another device has changed the library.
  // The startup sync already ran; a failure here is silent and leaves the cached list in place.
  useEffect(() => { void syncThemeLibrary(); void syncAppearance(); }, []);
  return <div className="flex flex-col gap-6">
    <p className="text-xs text-fg-3"><Trans>仅保存在这个浏览器。</Trans></p>
    {/* Untitled: the page title already says it. */}
    <Group>
      <Row title={t`明暗`}>
        <Segmented<ThemeMode> size="xs" value={mode} onChange={setThemeMode} ariaLabel={t`明暗`} options={[{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }]} />
      </Row>
    </Group>
    {catalog && (catalog.presets.length > 0 || catalog.backgrounds.length > 0) && <Group>
      {catalog.presets.length > 0 && <Row title={t`预设`}>
        <AppearanceChoice label={t`预设`} items={catalog.presets} value={catalog.presets.some((preset) => preset.id === selection.preset) ? selection.preset : undefined} onChange={(id) => selectPreset(id === APPEARANCE_DEFAULT ? undefined : id)} />
      </Row>}
      {catalog.backgrounds.length > 0 && <Row title={t`背景`}>
        <AppearanceChoice label={t`背景`} items={catalog.backgrounds} value={effective.background?.id} onChange={(id) => selectAppearanceItem('background', id)} />
      </Row>}
    </Group>}
    <Group title={t`配色`}>
      <div className="grid grid-cols-2 gap-2 pt-3.5 pb-2 max-md:grid-cols-1">
        {themes.map((theme) => <ThemeCard key={theme.id} theme={theme} selected={!paletteKey && theme.id === themeId} onEdit={theme.builtin ? undefined : () => openEditor({ edit: theme.id })} />)}
        {/* A plugin's palette sits among the themes without replacing the one chosen above. */}
        {plugins.map(({ palette, key }) => <ThemeCard key={key} theme={{ id: key, name: localizedText(palette.title) ?? palette.id }} selected={paletteKey === key} onSelect={() => selectAppearanceItem('palette', palette.id)} />)}
        {/* A new theme starts from the one on screen: pick the closest, then reshape it. */}
        <button
          type="button"
          onClick={() => openEditor({ from: paletteKey ?? themeId })}
          className="flex min-h-11 items-center gap-3 rounded-lg border border-dashed border-line-strong px-2.5 py-2 text-left text-sm text-fg-2 transition-colors hover:bg-hover hover:text-fg"
        >
          <span className="flex h-6 w-9 shrink-0 items-center justify-center"><IconPlus className="size-4" /></span>
          <Trans>新建主题</Trans>
        </button>
      </div>
      {/* Upstream credits sit under the gallery rather than in the cards, so every card is one line. */}
      <p className="pb-3.5 text-xs text-fg-3"><Trans>配色来源：{credits}</Trans></p>
    </Group>
    <Group title={t`代码高亮`}>
      <Row title={t`风格`}>
        <div className="flex items-center gap-2 max-md:w-full">
          <Select<string>
            label={t`风格`}
            className="w-48 max-md:min-w-0 max-md:flex-1"
            value={effectiveCodeValue}
            onChange={(value) => setDisplaySettings({ codeTheme: parseCodeThemeSelection(value) })}
            options={[
              { value: CODE_THEME_AUTO, label: t`跟随界面主题` },
              ...BUILTIN_CODE_THEMES.map((item) => ({
                value: item.id,
                label: item.id === 'monochrome' ? t`极简墨色` : item.name,
              })),
              ...customSyntaxThemes.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
          />
          <Button
            size="sm"
            onClick={() => {
              const syntaxFrom = isKnownCodeThemeId(effectiveCodeValue) ? effectiveCodeValue : undefined;
              if (selectedCustomSyntax) openEditor({ edit: display.codeTheme, openSyntax: true, syntaxFrom });
              else if (!paletteKey && isCustomThemeId(themeId)) openEditor({ edit: themeId, openSyntax: true, syntaxFrom });
              else openEditor({ from: paletteKey ?? themeId, openSyntax: true, syntaxFrom });
            }}
          >
            <Trans context="settings-code-theme-customize">自定义…</Trans>
          </Button>
        </div>
      </Row>
      <CodeThemePreview />
    </Group>
    {editorTarget && <Suspense fallback={null}><ThemeEditor open={editorOpen} target={editorTarget} onOpenChange={setEditorOpen} /></Suspense>}
  </div>;
}

/** 排版: the conversation's text size and spacing, with a sample of both. */
export function TypographySection() {
  const { t } = useLingui();
  const display = useDisplaySettings();
  const { catalog, effective } = useAppearance();
  const [uiFonts, monoFonts] = [fontsOf(catalog, 'ui'), fontsOf(catalog, 'mono')];
  return <div className="flex flex-col gap-6">
    <p className="text-xs text-fg-3"><Trans>仅保存在这个浏览器。</Trans></p>
    <Group>
      {uiFonts.length > 0 && <Row title={t`界面字体`}>
        <AppearanceChoice label={t`界面字体`} items={uiFonts} value={effective.uiFont?.id} onChange={(id) => selectAppearanceItem('uiFont', id)} />
      </Row>}
      {monoFonts.length > 0 && <Row title={t`等宽字体`}>
        <AppearanceChoice label={t`等宽字体`} items={monoFonts} value={effective.monoFont?.id} onChange={(id) => selectAppearanceItem('monoFont', id)} />
      </Row>}
      <Row title={t`文字大小`}>
        <Segmented<TextSize> size="xs" value={display.textSize} onChange={(textSize) => setDisplaySettings({ textSize })} ariaLabel={t`文字大小`} options={[{ value: 'small', label: t`小` }, { value: 'standard', label: t`标准` }, { value: 'large', label: t`大` }, { value: 'extra-large', label: t`特大` }]} />
      </Row>
      <Row title={t`会话间距`}>
        <Segmented<Density> size="xs" value={display.density} onChange={(density) => setDisplaySettings({ density })} ariaLabel={t`会话间距`} options={[{ value: 'compact', label: t`紧凑` }, { value: 'standard', label: t`标准` }, { value: 'relaxed', label: t`宽松` }]} />
      </Row>
    </Group>
    {/* The sample demonstrates the size and spacing chosen above. */}
    <Group title={t`预览`}>
      <div className="flex flex-col py-4" style={{ gap: display.density === 'compact' ? 6 : display.density === 'relaxed' ? 14 : 10 }}>
        <p className="text-base font-medium text-fg"><Trans>今天的工作</Trans></p>
        <p className="text-sm text-fg-2"><Trans>检查项目进度，继续处理会话。</Trans></p>
      </div>
    </Group>
  </div>;
}

/** 终端: the terminal's font size and padding. */
export function TerminalSettingsSection() {
  const { t } = useLingui();
  const display = useDisplaySettings();
  return <div className="flex flex-col gap-6">
    <p className="text-xs text-fg-3"><Trans>仅保存在这个浏览器。</Trans></p>
    <Group>
      <Row title={t`字号`}>
        <Segmented<string> size="xs" value={String(display.terminalFontSize)} onChange={(value) => setDisplaySettings({ terminalFontSize: Number(value) })} ariaLabel={t`终端字号`} options={terminalFontSizes.map((size, index) => ({ value: String(size), label: [t`小`, t`标准`, t`大`, t`特大`][index] ?? String(size) }))} />
      </Row>
      {([
        { key: 'terminalPaddingHorizontal', label: t`水平边距`, max: MAX_TERMINAL_PADDING_HORIZONTAL },
        { key: 'terminalPaddingVertical', label: t`垂直边距`, max: MAX_TERMINAL_PADDING_VERTICAL },
      ] as const).map(({ key, label, max }) => (
        <Row key={key} title={label}>
          <div className="flex w-64 max-w-full items-center gap-2 max-md:w-full">
            <Slider
              min={0}
              max={max}
              step={2}
              value={display[key]}
              aria-label={label}
              className="min-w-0 flex-1"
              onValueChange={(value) => setDisplaySettings({ [key]: value })}
            />
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-fg-3">{display[key]} px</span>
            <Tip label={t`恢复默认`}>
              <Button
                variant="quiet"
                size="icon-xs"
                aria-label={t`恢复默认：${label}`}
                disabled={display[key] === defaultDisplaySettings[key]}
                onClick={() => setDisplaySettings({ [key]: defaultDisplaySettings[key] })}
              ><IconRotateCcw /></Button>
            </Tip>
          </div>
        </Row>
      ))}
    </Group>
  </div>;
}

/** 图标: the browser's app icon and the permission mode icon style. */
export function AppIconSection() {
  const { t } = useLingui();
  const appIcon = useAppIcon();
  const permissionIconStyle = usePermissionIconStyle();
  return <div className="flex flex-col gap-6">
    <p className="text-xs text-fg-3"><Trans>仅保存在这个浏览器。</Trans></p>
    <Group title={t`应用图标`}>
      <div className="flex flex-wrap gap-2 pt-3.5 pb-2">
        {appIcons.map((icon) => <button
          key={icon.id}
          type="button"
          aria-label={icon.name}
          title={icon.name}
          aria-pressed={icon.id === appIcon}
          onClick={() => setAppIcon(icon.id)}
          className={cn('rounded-xl border-2 p-0.5 transition-colors', icon.id === appIcon ? 'border-accent' : 'border-transparent hover:border-line-strong')}
        >
          <AppIconTile accent={icon.accent} className="size-10" />
        </button>)}
      </div>
      <p className="pb-3.5 text-xs text-fg-3"><Trans>已安装的 Web 应用图标不变。</Trans></p>
    </Group>
    <Group title={t`权限图标`}>
      <Row title={t`风格`}>
        <Segmented<PermissionIconStyle>
          size="xs"
          value={permissionIconStyle}
          onChange={setPermissionIconStyle}
          ariaLabel={t`权限图标风格`}
          options={[
            { value: 'shield', label: t`盾牌` },
            { value: 'semantic', label: t`语义` },
            { value: 'gate', label: t`门禁` },
            { value: 'ring', label: t`圆环` },
          ]}
        />
      </Row>
      <PermissionIconPreview style={permissionIconStyle} />
    </Group>
  </div>;
}

function notificationBlocker(): string | undefined {
  if (!window.isSecureContext) return i18n._(msg`需要通过 localhost 或 HTTPS 访问才能启用通知。`);
  if (!('Notification' in window)) return i18n._(msg`此浏览器不支持通知。`);
  if (Notification.permission === 'denied') return i18n._(msg`浏览器已拒绝通知，请在网站设置中允许后重试。`);
  return undefined;
}

/** 通用设置: the language this browser shows. */
export function GeneralSection() {
  const { t } = useLingui();
  const locale = useLocale();
  return <Group note={t`仅保存在这个浏览器。`}>
    <Row title={t`语言`}>
      <Segmented<CatalogLocale> size="xs" value={locale} onChange={setLocale} ariaLabel={t`语言`} options={localeOptions} />
    </Row>
  </Group>;
}

/** 通知: the server's session notifications, and this browser's permission to show them. */
export function NotificationsSection({ settings, onSaved, onError }: ServerSettingsProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [, refreshPermission] = useState(0);
  useEffect(() => {
    const refresh = () => refreshPermission((value) => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  const blocker = notificationBlocker();
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const toggle = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (enabled) {
        if (blocker) { onError(blocker); return; }
        const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        refreshPermission((value) => value + 1);
        if (result !== 'granted') { onError(result === 'denied' ? t`浏览器拒绝了通知权限。` : t`未授予通知权限。`); return; }
      }
      const patch = { notifications: enabled };
      onSaved(await api.updateSettings(patch), patch);
    } catch (error) { onError(errorMessage(error, t`无法保存通知设置`)); }
    finally { setBusy(false); }
  };
  return <Group>
    <Row title={t`会话提醒`} description={t`保存在服务器；每个浏览器需单独允许通知。页面打开并连接服务器时才会通知；关闭标签页或断开后不推送。`}>
      <Switch aria-label={t`会话提醒`} checked={settings.notifications === true} disabled={busy || (Boolean(blocker) && settings.notifications !== true)} onCheckedChange={(value) => void toggle(value)} />
    </Row>
    {/* Granted is the normal state and needs no row. */}
    {permission !== 'granted' && <Row title={t`浏览器通知权限`} description={blocker}>
      <span className="text-xs text-fg-3">{permission === 'denied' ? t`已拒绝` : permission === 'unsupported' ? t`不支持` : t`尚未授权`}</span>
    </Row>}
  </Group>;
}

export function InteractionSection({ settings, onSaved, onError }: ServerSettingsProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const behavior = readEnterKeyBehavior(settings.composerEnterBehavior);
  const runningBehavior = readComposerRunningBehavior(settings.composerRunningBehavior);
  const persist = async (patch: Pick<AppSettings, 'composerEnterBehavior' | 'composerRunningBehavior' | 'composerSendLater'>) => {
    if (busy) return;
    setBusy(true);
    try { onSaved(await api.updateSettings(patch), patch); }
    catch (error) { onError(errorMessage(error, t`无法保存消息输入设置`)); }
    finally { setBusy(false); }
  };
  return <Group>
    <Row title={t`Enter 键`} description={t`保存在服务器，所有设备生效。只影响物理键盘，手机软键盘始终换行。`}>
      <div className={busy ? 'pointer-events-none opacity-50' : ''} aria-busy={busy}>
        <Segmented<EnterKeyBehavior> size="xs" value={behavior} onChange={(next) => { if (next !== behavior) void persist({ composerEnterBehavior: next }); }} ariaLabel={t`Enter 键`} options={[{ value: 'newline', label: t`换行`, disabled: busy }, { value: 'send', label: t`发送`, disabled: busy }]} />
      </div>
    </Row>
    <Row title={t`运行中发送的消息`}>
      <div className={busy ? 'pointer-events-none opacity-50' : ''} aria-busy={busy}>
        <Segmented<ComposerRunningBehavior> size="xs" value={runningBehavior} onChange={(next) => { if (next !== runningBehavior) void persist({ composerRunningBehavior: next }); }} ariaLabel={t`运行中发送的消息`} options={[{ value: 'queue', label: t({ message: '排队', context: 'settings-composer-queue' }), disabled: busy }, { value: 'steer', label: t`补充到当前任务`, disabled: busy }]} />
      </div>
    </Row>
    <Row title={t`展示稍后发送按钮`}>
      <Switch aria-label={t`展示稍后发送按钮`} checked={settings.composerSendLater === true} disabled={busy} onCheckedChange={(value) => void persist({ composerSendLater: value })} />
    </Row>
  </Group>;
}

const IDLE_RECLAIM_PRESETS = [0, 60, 360, 1440];
const MEMORY_LIMIT_PRESETS_MB = [0, 2048, 4096, 8192, 16384];
/** The presets, plus a value set elsewhere (another client, the API) so the control still shows it. */
const withCurrent = (presets: number[], current: number) => presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);

/** When the server stops the CLIs of conversations nobody uses; the next message resumes them. */
export function ReclaimSection({ settings, onSaved, onError }: ServerSettingsProps) {
  const { t } = useLingui();
  const idleLabel = (minutes: number) => minutes === 0 ? t({ message: '关闭', context: 'option-off' }) : minutes % 60 === 0 ? t`${minutes / 60} 小时` : t`${minutes} 分钟`;
  const [busy, setBusy] = useState(false);
  const idle = settings.idleReclaimMinutes ?? AGENT_PROCESS_BUDGET.idleMinutes;
  const memoryMb = settings.maxAgentMemoryMb ?? AGENT_PROCESS_BUDGET.memoryBytes / (1024 * 1024);
  const persist = async (patch: Pick<AppSettings, 'idleReclaimMinutes' | 'maxAgentMemoryMb'>) => {
    if (busy) return;
    setBusy(true);
    try { onSaved(await api.updateSettings(patch), patch); }
    catch (error) { onError(errorMessage(error, t`无法保存资源回收设置`)); }
    finally { setBusy(false); }
  };
  return <Group title={t`资源回收`}>
    <Row title={t`空闲后停止 CLI`} description={t`停止后发消息会接着原对话继续；CLI 里的后台任务会一起结束。`}>
      <div className={busy ? 'pointer-events-none opacity-50' : ''} aria-busy={busy}>
        <Segmented<string> size="xs" value={String(idle)} onChange={(next) => { if (Number(next) !== idle) void persist({ idleReclaimMinutes: Number(next) }); }} ariaLabel={t`空闲后停止 CLI`} options={withCurrent(IDLE_RECLAIM_PRESETS, idle).map((value) => ({ value: String(value), label: idleLabel(value), disabled: busy }))} />
      </div>
    </Row>
    <Row title={t`CLI 内存上限`}>
      <div className={busy ? 'pointer-events-none opacity-50' : ''} aria-busy={busy}>
        <Segmented<string> size="xs" value={String(memoryMb)} onChange={(next) => { if (Number(next) !== memoryMb) void persist({ maxAgentMemoryMb: Number(next) }); }} ariaLabel={t`CLI 内存上限`} options={withCurrent(MEMORY_LIMIT_PRESETS_MB, memoryMb).map((value) => ({ value: String(value), label: value === 0 ? t`不限` : value % 1024 === 0 ? `${value / 1024} GB` : `${value} MB`, disabled: busy }))} />
      </div>
    </Row>
  </Group>;
}

export function FilesSettingsSection({ settings, onSaved, onError, onDirtyChange, onBusyChange }: ServerSettingsProps & { onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const { t } = useLingui();
  const projectlessTasks = useLists((state) => state.projectlessTasks);
  const [root, setRoot] = useState(settings.taskWorkspaceRoot ?? '');
  const rootBaseline = useRef(settings.taskWorkspaceRoot ?? '');
  const [location, setLocation] = useState<Awaited<ReturnType<typeof api.taskWorkspaceLocation>>>();
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    const saved = settings.taskWorkspaceRoot ?? '';
    const previousRoot = rootBaseline.current;
    setRoot((current) => current === previousRoot ? saved : current);
    rootBaseline.current = saved;
    if (!projectlessTasks) return;
    let active = true;
    void api.taskWorkspaceLocation().then((value) => { if (active) setLocation(value); }).catch((error) => { if (active) onError(errorMessage(error, t`无法读取无项目会话的目录`)); });
    return () => { active = false; };
  }, [settings.taskWorkspaceRoot, projectlessTasks, onError, t]);
  const [editor, setEditor] = useState(settings.editorCommand ?? '');
  const baseline = useRef(settings.editorCommand ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = editor !== (settings.editorCommand ?? '') || root !== (settings.taskWorkspaceRoot ?? '');
  useEffect(() => {
    const saved = settings.editorCommand ?? '';
    const previous = baseline.current;
    setEditor((current) => current === previous ? saved : current);
    baseline.current = saved;
  }, [settings.editorCommand]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    const patch = { editorCommand: editor, ...(projectlessTasks ? { taskWorkspaceRoot: root.trim() } : {}) };
    try {
      const saved = await api.updateSettings(patch);
      onSaved(saved, patch);
      setEditor(saved.editorCommand ?? '');
      setRoot(saved.taskWorkspaceRoot ?? '');
    } catch (error) { onError(errorMessage(error, t`无法保存编辑器设置`)); }
    finally { setBusy(false); }
  };
  const outside = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    const patch = { allowOutsideRead: enabled };
    try { onSaved(await api.updateSettings(patch), patch); }
    catch (error) { onError(errorMessage(error, t`无法保存文件访问设置`)); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-6">
    <p className="text-xs text-fg-3"><Trans>保存在服务器，所有设备生效。</Trans></p>
    {projectlessTasks && <Group>
      <Row title={t`无项目会话的目录`} description={t`服务器目录，仅影响新建的会话。`}>
        <div className="flex w-80 min-w-0 items-center gap-1.5 max-md:w-full">
          <Input aria-label={t`无项目会话的目录`} disabled={busy} className="h-8 min-w-0 flex-1 font-mono max-md:h-11" value={root} placeholder={location?.path} onChange={(event) => setRoot(event.target.value)} />
          <Button size="icon-sm" variant="quiet" aria-label={t`浏览…`} disabled={busy} onClick={() => setPickerOpen(true)}><IconFolderOpen /></Button>
          {root && <Button size="xs" variant="ghost" disabled={busy} onClick={() => setRoot('')}><Trans>默认</Trans></Button>}
        </div>
      </Row>
      {location && root.trim() && root.trim() !== location.path && <p className="break-all pb-2 font-mono text-xs text-fg-3">{location.path}</p>}
      {location?.error && <p role="status" className="pb-2 text-xs text-warning">{textOf({ code: location.error }) ?? t`无法读取无项目会话的目录`}</p>}
    </Group>}
    <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} initialPath={root.trim() || location?.path} onPick={setRoot} onError={onError} />
    <Group title={t`文件访问`}>
      <Row title={t`允许预览项目外的文件`} description={t`只读打开项目外路径；文件树与搜索仍限定在项目内。`}>
        <Switch aria-label={t`允许预览项目外的文件`} checked={settings.allowOutsideRead !== false} disabled={busy} onCheckedChange={(value) => void outside(value)} />
      </Row>
    </Group>
    <Group title={t`编辑器`}>
      <Row title={t`编辑器命令`} description={t`在服务器电脑上运行。`}>
        <Input aria-label={t`编辑器命令`} disabled={busy} className="h-8 w-56 max-md:h-11 max-md:w-full" value={editor} placeholder="code" onChange={(event) => setEditor(event.target.value)} />
      </Row>
    </Group>
    {dirty && <div className="flex justify-end py-3">
      <Button size="sm" variant="primary" className="max-md:h-11" disabled={busy} onClick={() => void save()}><IconSave />{busy ? <Trans>保存中…</Trans> : <Trans>保存</Trans>}</Button>
    </div>}
  </div>;
}

/** 连接与访问: the server this browser is signed in to, and the shares that reach it from outside. */
export function ConnectionSection({ onLogout, onOpenShares }: { onLogout?: () => void; onOpenShares: () => void }) {
  const { t } = useLingui();
  const [connectOpen, setConnectOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  // A phone or tablet scans another device's code directly, as the apps do; a desktop types it.
  const touch = useMediaQuery('(pointer: coarse)');
  return <div className="flex flex-col gap-6">
    <Group title={t`当前服务器`}>
      <Row title={t`地址`}><span className="break-all font-mono text-xs text-fg-2">{window.location.origin}</span></Row>
    </Group>
    <Group>
      <Row title={t`配对新设备`}><Button size="sm" variant="secondary" onClick={() => setPairOpen(true)}><IconQrCode className="size-4" /><Trans>生成配对码</Trans></Button></Row>
      <Row title={t`连接其他服务器`}><div className="flex gap-2">
        {touch && <Button size="sm" variant="secondary" className="max-md:h-11" onClick={() => setScannerOpen(true)}><IconQrCode className="size-4" /><Trans>扫码</Trans></Button>}
        <Button size="sm" variant="secondary" className="max-md:h-11" onClick={() => setConnectOpen(true)}>{t({ message: '连接', context: 'settings-connect-action' })}</Button>
      </div></Row>
    </Group>
    {onLogout && <Group title={t`访问`}>
      <Row title={t`退出登录`} description={t`只退出这个浏览器。`}><Button size="sm" variant="danger-ghost" onClick={onLogout}><IconLogOut /><Trans>退出</Trans></Button></Row>
    </Group>}
    <Group>
      <SettingsLinkRow title={t`会话分享`} onClick={onOpenShares} />
    </Group>
    <PairDeviceDialog open={pairOpen} onOpenChange={setPairOpen} />
    <ConnectServerDialog open={connectOpen} onOpenChange={setConnectOpen} />
    <PairingQrScanner open={scannerOpen} onOpenChange={setScannerOpen} />
  </div>;
}

export function AboutSection() {
  return <UpdateSection />;
}
