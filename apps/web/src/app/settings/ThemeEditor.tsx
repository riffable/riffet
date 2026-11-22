import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  CODE_THEME_ROLES, contrastRatio, importCodeThemeJson, normalizeThemeColor, normalizeThemeSeed, parseColor, resolveCodeThemeId, THEME_ANSI_KEYS, THEME_ROLES, validateCustomThemes,
  type CodeThemeRole, type CustomCodeSyntax, type CustomCodeSyntaxHalf, type CustomTheme, type ThemeDesign, type ThemeGradient, type ThemePalette, type ThemeRole, type ThemeSeed, type ThemeValidationIssue,
} from '@contracts';
import { BrandMark } from '@/components/BrandMark';
import { IconArrowUp, IconCalendarClock, IconFolderOpen, IconPlus, IconSearch, IconSquarePen } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input, Select, Switch, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { HttpError } from '@/lib/api';
import { pluginPaletteColors } from '@/lib/appearance';
import { BUILTIN_CODE_THEMES, codeThemeDefinition } from '@/lib/code-themes.generated';
import { confirmDialog, useDiscardGuard } from '@/lib/dialogs';
import { cachedHighlight, highlightCode } from '@/lib/highlight';
import { setThemeId, useTheme } from '@/lib/theme';
import { customThemeCss, currentThemeLibrary, saveThemeLibrary, syncThemeLibrary } from '@/lib/theme-library';
import { DEFAULT_THEME_ID } from '@/lib/themes';
import { CODE_ROLE_LABELS, THEME_ANSI_LABELS, THEME_CONTRAST_CHECKS, THEME_ROLE_GROUPS, THEME_ROLE_LABELS } from '@/lib/theme-role-labels';
import { applySeed, deriveSeedGradient, inferSeed } from '@/lib/theme-seed';
import { toast } from '@/lib/toast';
import { cn, errorMessage } from '@/lib/utils';
import { ANSI_BY_THEME } from '@/lib/theme-ansi.generated';
import { BUILTIN_THEME_PALETTES } from '@/lib/theme-builtins.generated';
import { ThemeCanvas } from './ThemeCanvas';

type Mode = 'light' | 'dark';

/** The editor's copy of a theme: every field is a string while it is being typed. */
interface Draft {
  id: string;
  name: string;
  description: string;
  palette: { light: ThemePalette; dark: ThemePalette };
  ansi: { light: string[]; dark: string[] };
  /** Preserve design overrides while this editor changes palette fields. */
  design?: ThemeDesign;
  /** Optional custom code syntax highlighting colors for light and dark modes. */
  syntax?: CustomCodeSyntax;
  /** Set once the canvas has drawn this palette; absent for a copy nobody has drawn yet. */
  seed?: ThemeSeed;
  /** Optional window/sidebar canvas gradient derived from 2–3 canvas points. */
  gradient?: ThemeGradient;
}

/** What the editor opens on: a new theme drawn from a palette, or an existing custom theme. */
export type ThemeEditorTarget =
  | { from: string; openSyntax?: boolean; syntaxFrom?: string }
  | { edit: string; openSyntax?: boolean; syntaxFrom?: string };

/**
 * The custom-theme editor, opened from the palette gallery.
 *
 * The library is server state shared by every device, so this dialog edits the whole document and
 * saves it with the revision it read. The preview is local: it injects a stylesheet for a
 * `preview-` id inside this dialog instead of touching `<html>`, so an unfinished palette cannot
 * leak into the page behind it.
 *
 * A new theme starts from whatever the reader is looking at, because the canvas redraws the roles
 * that make a theme feel different and the rest (status, diff, terminal) is best inherited.
 *
 * Structural problems (a missing role, a malformed colour) block saving. Contrast is shown as
 * advice and never blocks: a readable palette is the author's judgement, not the server's gate.
 */
export function ThemeEditor({ open, target, onOpenChange }: { open: boolean; target: ThemeEditorTarget; onOpenChange: (open: boolean) => void }) {
  const { t } = useLingui();
  const { resolved } = useTheme();
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The draft as it was started; any edit replaces the object, so identity says whether it changed. */
  const [pristine, setPristine] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  // The draft outlives the dialog (it animates out on it), so only an open editor guards the page.
  const discard = useDiscardGuard(open && draft !== null && draft !== pristine, saving);
  const editing = 'edit' in target;
  const [mode, setMode] = useState<Mode>('light');
  const [issues, setIssues] = useState<ThemeValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ base: CustomTheme[]; revision?: string } | null>(null);
  const openSyntax = Boolean(target.openSyntax);

  // Every opening starts a fresh draft from its target, in the mode the page is showing.
  useEffect(() => {
    if (!open) return;
    setIssues([]);
    setError(null);
    setConflict(null);
    setSaving(false);
    setMode(resolved);
    const next = 'edit' in target ? editDraft(target.edit) : newDraft(target.from, t`我的主题`);
    const syntaxSeed = target.syntaxFrom ?? resolveCodeThemeId('auto', 'from' in target ? target.from : target.edit);
    const withSyntax = next && openSyntax && !next.syntax
      ? { ...next, syntax: syntaxFromPreset(syntaxSeed) }
      : next;
    setDraft(withSyntax);
    setPristine(withSyntax);
    if (!next) setError(t`这套主题已经被其他设备删除，请重新加载主题库。`);
    // `resolved` is read once per opening; following it would reset the tab mid-edit.
  }, [open, target]);

  const finish = () => onOpenChange(false);

  const persist = async (themes: CustomTheme[], expectedRevision: string, base: CustomTheme[], id: string) => {
    setSaving(true);
    setError(null);
    setIssues([]);
    try {
      await saveThemeLibrary(themes, expectedRevision);
      // A theme made here is made to be used; an edited one keeps whatever this device had chosen.
      if (!editing) setThemeId(id);
      setConflict(null);
      finish();
    } catch (failure) {
      if (failure instanceof HttpError && failure.status === 409) {
        const latest = (failure.details as { revision?: unknown } | undefined)?.revision;
        setConflict({ base, revision: typeof latest === 'string' ? latest : undefined });
      } else {
        setError(errorMessage(failure, t`无法保存主题`));
      }
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!draft || saving) return;
    const built = buildTheme(draft);
    const current = currentThemeLibrary();
    const exists = current.themes.some((theme) => theme.id === built.id);
    if (editing && !exists) {
      setError(t`这套主题已经被其他设备删除，请重新加载主题库。`);
      return;
    }
    const checked = validateCustomThemes(withDraft(current.themes, built));
    if (checked.issues.length) {
      setIssues(checked.issues);
      return;
    }
    void persist(checked.themes, current.revision, current.themes, built.id);
  };

  const remove = async () => {
    if (!draft || saving) return;
    const name = draft.name.trim() || t`这套主题`;
    const confirmed = await confirmDialog({
      title: t`删除主题？`,
      description: t`“${name}”会从所有设备上移除，正在使用它的设备会回到 Riffet。`,
      confirmLabel: t({ message: '删除', context: 'settings-delete-action' }),
      destructive: true,
    });
    if (!confirmed) return;
    const current = currentThemeLibrary();
    setSaving(true);
    setError(null);
    try {
      await saveThemeLibrary(current.themes.filter((entry) => entry.id !== draft.id), current.revision);
      finish();
    } catch (failure) {
      // A concurrent edit is not a reason to delete blindly: load the newest library and let the
      // reader try again against what is actually there.
      if (failure instanceof HttpError && failure.status === 409) {
        await syncThemeLibrary();
        toast.error(t`主题库已更新，请确认后再删除`);
      } else {
        setError(errorMessage(failure, t`无法删除主题`));
      }
    } finally {
      setSaving(false);
    }
  };

  const overwrite = async () => {
    if (!conflict || !draft || saving) return;
    // Rebuild from the draft rather than from the snapshot taken at 409: the reader may have kept
    // editing while the banner was up, and those changes belong in the overwrite.
    let base = conflict.base;
    let revision = conflict.revision;
    if (!revision) {
      await syncThemeLibrary();
      base = currentThemeLibrary().themes;
      revision = currentThemeLibrary().revision;
    }
    const built = buildTheme(draft);
    const checked = validateCustomThemes(withDraft(base, built));
    if (checked.issues.length) {
      setIssues(checked.issues);
      return;
    }
    await persist(checked.themes, revision, base, built.id);
  };

  /** Takes the other device's version: this draft is dropped with the dialog. */
  const reload = async () => {
    if (saving) return;
    await syncThemeLibrary();
    finish();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next) onOpenChange(true); else discard.close(finish); }}>
      <DialogContent size="content" mobileFullscreen>
        <DialogHeader>
          <DialogTitle>{editing ? t`编辑主题` : t`新建主题`}</DialogTitle>
          <DialogDescription><Trans>保存在服务器；每台设备各自选择。</Trans></DialogDescription>
        </DialogHeader>

        <DialogBody>
          {error && <Notice tone="danger" role="alert" className="mb-3">{error}</Notice>}
          {conflict && (
            <Notice tone="warning" className="mb-3 flex-wrap" action={(
              <div className="flex flex-wrap gap-2">
                <Button size="xs" onClick={() => void reload()}><Trans>重新加载最新版</Trans></Button>
                <Button size="xs" variant="primary" onClick={() => void overwrite()}><Trans>以本地版本覆盖</Trans></Button>
              </div>
            )}><Trans>主题库已在其他设备上更新。</Trans></Notice>
          )}

          {/* Edits made while a save is in flight would be closed away with the dialog. */}
          {draft && (
            <fieldset disabled={saving} className="min-w-0 disabled:pointer-events-none">
              <ThemeForm
                draft={draft}
                mode={mode}
                issues={issues}
                openSyntax={openSyntax}
                onChange={setDraft}
                onMode={setMode}
              />
            </fieldset>
          )}
        </DialogBody>

        <DialogFooter>
          {editing && draft && (
            <Button variant="danger-ghost" className="mr-auto" disabled={saving} onClick={() => void remove()}><Trans context="settings-delete-action">删除</Trans></Button>
          )}
          <Button variant="ghost" onClick={() => discard.close(finish)}><Trans context="settings-cancel-action">取消</Trans></Button>
          <Button variant="primary" disabled={saving || !draft} onClick={save}>{saving ? <Trans>保存中…</Trans> : <Trans>保存</Trans>}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ThemeForm({ draft, mode, issues, openSyntax, onChange, onMode }: {
  draft: Draft;
  mode: Mode;
  issues: ThemeValidationIssue[];
  openSyntax?: boolean;
  onChange: (draft: Draft) => void;
  onMode: (mode: Mode) => void;
}) {
  const { t } = useLingui();
  const palette = draft.palette[mode];
  const modeLabel = mode === 'light' ? t`浅色` : t`深色`;
  const setColor = (role: ThemeRole, value: string) => {
    onChange({
      ...draft,
      ...(role === 'bg-sidebar' ? { gradient: undefined } : {}),
      palette: { ...draft.palette, [mode]: { ...palette, [role]: value } },
    });
  };
  const setAnsi = (index: number, value: string) => {
    const colors = [...draft.ansi[mode]];
    colors[index] = value;
    onChange({ ...draft, ansi: { ...draft.ansi, [mode]: colors } });
  };
  // A palette nobody has drawn yet shows where it would sit; the first touch takes it over.
  const inferred = useMemo(() => (draft.seed ? null : inferSeed(draft.palette)), [draft.seed, draft.palette]);
  const setSeed = (next: ThemeSeed) => {
    const seed = normalizeThemeSeed(next);
    const gradient = deriveSeedGradient(seed);
    onChange({ ...draft, seed, gradient, palette: applySeed(draft.palette, draft.seed, seed) });
  };

  return (
    <div className="flex flex-col gap-4 py-1">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-fg-3">
          <Trans>名称</Trans>
          <Input value={draft.name} maxLength={60} onChange={(event) => onChange({ ...draft, name: event.target.value })} aria-label={t`主题名称`} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-3">
          <Trans>说明（可选）</Trans>
          <Input value={draft.description} maxLength={200} onChange={(event) => onChange({ ...draft, description: event.target.value })} aria-label={t`主题说明`} />
        </label>
      </div>

      {issues.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          {issues.slice(0, 8).map((issue, index) => <li key={`${index}-${issue.path}-${issue.message}`}>{issueMessage(issue)}</li>)}
          {issues.length > 8 && <li><Trans>还有 {issues.length - 8} 处问题…</Trans></li>}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg bg-muted p-0.5" role="tablist" aria-label={t`配色模式`}>
          {(['light', 'dark'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => onMode(value)}
              className={cn(
                'h-7 rounded-md px-3 text-xs transition-colors',
                mode === value ? 'bg-elevated font-medium text-fg shadow-soft' : 'text-fg-3 hover:text-fg',
              )}
            >
              {value === 'light' ? <Trans>浅色</Trans> : <Trans>深色</Trans>}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[16rem_minmax(0,1fr)]">
        <ThemeCanvas seed={draft.seed ?? inferred!} onChange={setSeed} />
        <Preview draft={draft} mode={mode} />
      </div>

      <details open={openSyntax || undefined}>
        <summary className="cursor-pointer text-xs font-medium text-fg-2"><Trans>逐项调整</Trans></summary>
        <div className="mt-3 flex flex-col gap-4">
          <span className="text-2xs text-fg-4"><Trans>颜色支持 #rrggbb 与 #rrggbbaa</Trans></span>

          {THEME_ROLE_GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col gap-2">
              <h4 className="text-xs font-medium text-fg-3">{group.title}</h4>
              <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {group.roles.map((role) => (
                  <ColorField
                    key={role}
                    label={THEME_ROLE_LABELS[role]}
                    value={palette[role]}
                    onChange={(value) => setColor(role, value)}
                  />
                ))}
              </div>
            </section>
          ))}

          <SyntaxSection
            draft={draft}
            mode={mode}
            defaultOpen={openSyntax}
            onChange={onChange}
            onMode={onMode}
          />

          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-fg-2"><Trans>终端颜色（16 色）</Trans></summary>
            <div className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {THEME_ANSI_KEYS.map((key, index) => (
                <ColorField
                  key={key}
                  label={THEME_ANSI_LABELS[key]}
                  value={draft.ansi[mode][index] ?? '#000000'}
                  onChange={(value) => setAnsi(index, value)}
                />
              ))}
            </div>
            <p className="mt-2 text-2xs text-fg-4"><Trans>终端只接受 #rrggbb，透明度会被忽略。</Trans></p>
          </details>

          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-fg-3">{t`对比度提示（${modeLabel}）`}</h4>
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {THEME_CONTRAST_CHECKS.map((check) => {
                const front = parseColor(palette[check.foreground]);
                const back = parseColor(palette[check.background]);
                const ratio = front && back ? contrastRatio(front, back) : null;
                const pass = ratio !== null && ratio >= check.minimum;
                return (
                  <div key={`${check.foreground}-${check.background}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-fg-3">{check.label}</span>
                    <span className={pass ? 'text-success' : 'text-warning'}>
                      {ratio === null ? <Trans>无法计算</Trans> : `${ratio.toFixed(2)}:1`}
                      {!pass && <Trans> · 建议 ≥ {check.minimum}:1</Trans>}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </details>
    </div>
  );
}

const SYNTAX_PREVIEW_SNIPPET = `// Syntax preview
@tagged("api")
async function loadConfig(limit = 42): Promise<Config> {
  const mode = true;
  return { name: "riffet", count: limit };
}`;

function syntaxFromPreset(id: string): CustomCodeSyntax {
  const preset = codeThemeDefinition(resolveCodeThemeId(id));
  return {
    light: { colors: { ...preset.light.colors }, commentItalic: preset.light.commentItalic ?? true },
    dark: { colors: { ...preset.dark.colors }, commentItalic: preset.dark.commentItalic ?? true },
  };
}

function SyntaxSection({ draft, mode, defaultOpen, onChange, onMode }: {
  draft: Draft;
  mode: Mode;
  defaultOpen?: boolean;
  onChange: (draft: Draft) => void;
  onMode: (mode: Mode) => void;
}) {
  const { t } = useLingui();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [previewHtml, setPreviewHtml] = useState<string | undefined>(() => cachedHighlight(SYNTAX_PREVIEW_SNIPPET, 'typescript'));

  useEffect(() => {
    let active = true;
    if (previewHtml === undefined) {
      void highlightCode(SYNTAX_PREVIEW_SNIPPET, 'typescript').then((html) => {
        if (active && html !== undefined) setPreviewHtml(html);
      });
    }
    return () => { active = false; };
  }, [previewHtml]);

  const syntax = draft.syntax;
  const half = syntax?.[mode];
  const previewCss = useMemo(() => (syntax ? customThemeCss([previewTheme(draft)]) : ''), [draft, syntax]);

  const enableSyntax = (presetId = DEFAULT_THEME_ID) => {
    onChange({ ...draft, syntax: syntaxFromPreset(presetId) });
  };

  const setSyntaxColor = (role: CodeThemeRole, value: string) => {
    if (!syntax) return;
    onChange({
      ...draft,
      syntax: {
        ...syntax,
        [mode]: {
          ...syntax[mode],
          colors: { ...syntax[mode].colors, [role]: value },
        },
      },
    });
  };

  const setCommentItalic = (commentItalic: boolean) => {
    if (!syntax) return;
    onChange({
      ...draft,
      syntax: { ...syntax, [mode]: { ...syntax[mode], commentItalic } },
    });
  };

  const applyImport = (raw: string) => {
    const result = importCodeThemeJson(raw);
    if (!result.ok) {
      setImportError(result.reason === 'invalid-json' ? t`JSON 格式无法解析` : t`未找到可用的 VS Code 语法配色字段`);
      return;
    }
    setImportError(null);
    if (result.value.syntax) {
      onChange({ ...draft, syntax: result.value.syntax });
      setImportOpen(false);
      setImportText('');
      toast.success(t`已导入深浅两套代码高亮配色`);
      return;
    }
    if (result.value.half) {
      const targetMode = result.value.mode ?? mode;
      const base = syntax ?? syntaxFromPreset(DEFAULT_THEME_ID);
      onChange({
        ...draft,
        syntax: { ...base, [targetMode]: result.value.half },
      });
      if (result.value.mode && result.value.mode !== mode) onMode(result.value.mode);
      setImportOpen(false);
      setImportText('');
      toast.success(targetMode === 'light' ? t`已导入浅色代码高亮配色` : t`已导入深色代码高亮配色`);
    }
  };

  const onFilePick = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setImportText(text);
      applyImport(text);
    } catch {
      setImportError(t`无法读取所选文件`);
    }
  };

  return (
    <details open={defaultOpen || undefined} className="rounded-lg border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-fg-2"><Trans>代码高亮（14 色）</Trans></summary>
      <div className="mt-3 flex flex-col gap-3">
        {!syntax ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" onClick={() => enableSyntax()}><Trans>自定义代码高亮</Trans></Button>
            <Button size="xs" variant="ghost" onClick={() => setImportOpen((value) => !value)}><Trans>导入 VS Code 主题…</Trans></Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select<string>
              label={t`套用预设`}
              value=""
              placeholder={t`套用预设…`}
              className="h-7 w-40 text-xs"
              onChange={(id) => enableSyntax(id)}
              options={BUILTIN_CODE_THEMES.map((item) => ({
                value: item.id,
                label: item.id === 'monochrome' ? t`极简墨色` : item.name,
              }))}
            />
            <Button size="xs" onClick={() => setImportOpen((value) => !value)}><Trans>导入 VS Code 主题…</Trans></Button>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onChange({ ...draft, syntax: undefined })}><Trans>恢复跟随主题</Trans></Button>
          </div>
        )}

        {importOpen && (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-subtle p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-2xs text-fg-3"><Trans>粘贴 VS Code 主题 JSON / JSONC 内容，或选择文件导入。</Trans></span>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.jsonc,application/json"
                className="sr-only"
                onChange={(event) => { void onFilePick(event.target.files?.[0]); event.target.value = ''; }}
              />
              <Button size="xs" onClick={() => fileRef.current?.click()}><Trans>选择文件…</Trans></Button>
            </div>
            <Textarea
              rows={4}
              value={importText}
              onChange={(event) => { setImportText(event.target.value); if (importError) setImportError(null); }}
              placeholder={t`粘贴 VS Code 主题 JSON（含 tokenColors）…`}
              aria-label={t`VS Code 主题 JSON`}
              className="font-mono text-xs"
            />
            {importError && <p role="alert" className="text-xs text-danger">{importError}</p>}
            <div className="flex justify-end gap-2">
              <Button size="xs" variant="ghost" onClick={() => { setImportOpen(false); setImportError(null); }}><Trans context="settings-cancel-action">取消</Trans></Button>
              <Button size="xs" variant="primary" disabled={!importText.trim()} onClick={() => applyImport(importText)}><Trans>应用导入</Trans></Button>
            </div>
          </div>
        )}

        {syntax && half && (
          <>
            <div
              data-theme={`preview-${draft.id}`}
              data-code-theme={`preview-${draft.id}`}
              className={cn('rounded-lg bg-subtle px-3 py-2.5 font-mono text-xs leading-5 text-fg', mode === 'dark' && 'dark')}
            >
              <style>{previewCss}</style>
              <pre className="overflow-x-auto">
                {previewHtml ? <code dangerouslySetInnerHTML={{ __html: previewHtml }} /> : <code>{SYNTAX_PREVIEW_SNIPPET}</code>}
              </pre>
            </div>
            <label className="flex items-center justify-between gap-2 py-0.5 text-xs text-fg-2">
              <span><Trans>注释斜体</Trans></span>
              <Switch checked={half.commentItalic ?? true} onCheckedChange={setCommentItalic} aria-label={t`注释斜体`} />
            </label>
            <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {CODE_THEME_ROLES.map((role) => (
                <ColorField
                  key={role}
                  label={CODE_ROLE_LABELS[role]}
                  value={half.colors[role]}
                  onChange={(value) => setSyntaxColor(role, value)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

/**
 * The live preview: a small Riffet window — sidebar, a conversation with a diff, the composer —
 * built from the same roles and shapes as the real page, so a palette is judged where it will live.
 * The stylesheet targets a `preview-` id that exists only inside this dialog, so the page behind
 * keeps its own theme while the draft changes. Values that are not valid hex yet are painted
 * transparent rather than written into CSS unvalidated.
 */
function Preview({ draft, mode }: { draft: Draft; mode: Mode }) {
  const css = customThemeCss([previewTheme(draft)]);
  const nav = [
    { icon: IconSquarePen, label: <Trans context="workbench-sidebar-new-action">新会话</Trans> },
    { icon: IconSearch, label: <Trans>搜索内容</Trans> },
    { icon: IconCalendarClock, label: <Trans>自动化</Trans> },
  ];
  return (
    <div
      aria-hidden
      className={cn('flex min-h-80 select-none overflow-hidden rounded-xl border border-line bg-canvas text-2xs leading-snug text-fg', mode === 'dark' && 'dark')}
      data-theme={`preview-${draft.id}`}
    >
      <style>{css}</style>
      <div className="flex w-[34%] shrink-0 flex-col gap-px p-2">
        <div className="mb-1.5 flex items-center gap-1.5 px-1.5 pt-0.5 text-xs font-semibold">
          <BrandMark className="size-3.5 shrink-0 text-fg" />Riffet
        </div>
        {nav.map(({ icon: Icon, label }, index) => (
          <div key={index} className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-fg-2">
            <Icon className="size-3 shrink-0 text-fg-3" /><span className="truncate">{label}</span>
          </div>
        ))}
        {/* design-rules: allow the miniature keeps one size under its 11px body */}
        <div className="mt-2.5 px-1.5 pb-1 text-[10px] text-fg-4"><Trans>项目</Trans></div>
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-fg-2">
          <IconFolderOpen className="size-3 shrink-0 text-fg-3" /><span className="truncate">riffet</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-md bg-active py-1 pr-1.5 pl-6 text-fg">
          <span className="truncate"><Trans>主题画板</Trans></span>
          <span className="ml-auto size-1.5 shrink-0 rounded-full bg-accent" />
        </div>
        <div className="truncate rounded-md py-1 pr-1.5 pl-6 text-fg-2"><Trans>同步失败排查</Trans></div>
        <div className="truncate rounded-md py-1 pr-1.5 pl-6 text-fg-2"><Trans>发布说明</Trans></div>
      </div>

      <div className="my-1.5 mr-1.5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-card">
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
          <span className="truncate font-medium"><Trans>主题画板</Trans></span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-fg-3"><span className="size-1.5 rounded-full bg-[var(--agent-claude)]" />Claude</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 py-3">
          <div className="max-w-[80%] self-end rounded-2xl bg-bubble px-2.5 py-1.5"><Trans>把配色改成画板</Trans></div>
          <p className="text-fg"><Trans>改好了，入口在 <span className="text-accent">ThemeCanvas.tsx</span>。</Trans></p>
          {/* design-rules: allow the miniature keeps one size under its 11px body */}
          <div className="overflow-hidden rounded-md border border-line font-mono text-[10px]">
            <div className="border-b border-line-soft bg-subtle px-2 py-1 text-fg-3">theme-seed.ts</div>
            <div className="bg-[var(--diff-add)] px-2 py-0.5"><span className="text-[var(--diff-add-marker)]">+ </span>points: [surface, accent]</div>
            <div className="bg-[var(--diff-del)] px-2 py-0.5"><span className="text-[var(--diff-del-marker)]">- </span>palette: copy(builtin)</div>
          </div>
          <p className="text-fg-3"><Trans>2 个文件 · 用时 1 分钟</Trans></p>
        </div>
        <div className="mx-2 mb-2 rounded-xl border border-line bg-elevated px-2.5 pt-2 pb-1.5 shadow-soft">
          <div className="text-fg-4"><Trans>继续描述…</Trans></div>
          <div className="mt-2 flex items-center gap-2 text-fg-3">
            <IconPlus className="size-3" />
            <span className="ml-auto">Claude</span>
            <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-fg"><IconArrowUp className="size-3" /></span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const { t } = useLingui();
  const id = useId();
  const normalized = normalizeThemeColor(value);
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="color"
        aria-label={t`${label} 取色`}
        value={normalized ? normalized.slice(0, 7) : '#000000'}
        onChange={(event) => onChange(event.target.value)}
        className="size-7 shrink-0 cursor-pointer rounded-md border border-line bg-transparent p-0.5"
      />
      <label htmlFor={id} className="min-w-0 flex-1 truncate text-xs text-fg-2">{label}</label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        spellCheck={false}
        className="h-6 w-24 shrink-0 rounded-md border border-line bg-elevated px-1.5 font-mono text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />
    </div>
  );
}

function withDraft(base: CustomTheme[], theme: CustomTheme): CustomTheme[] {
  return base.some((entry) => entry.id === theme.id)
    ? base.map((entry) => (entry.id === theme.id ? theme : entry))
    : [...base, theme];
}

function buildTheme(draft: Draft): CustomTheme {
  const description = draft.description.trim();
  return {
    id: draft.id,
    name: draft.name.trim(),
    ...(description ? { description } : {}),
    palette: { light: { ...draft.palette.light }, dark: { ...draft.palette.dark } },
    ansi: { light: [...draft.ansi.light], dark: [...draft.ansi.dark] },
    ...(draft.design ? { design: structuredClone(draft.design) } : {}),
    ...(draft.syntax ? { syntax: structuredClone(draft.syntax) } : {}),
    ...(draft.seed ? { seed: structuredClone(draft.seed) } : {}),
    ...(draft.gradient ? { gradient: structuredClone(draft.gradient) } : {}),
  };
}

function previewTheme(draft: Draft): CustomTheme {
  const clean = (value: string | undefined) => normalizeThemeColor(value) ?? 'transparent';
  const cleanOpaque = (value: string | undefined) => normalizeThemeColor(value) ?? '#000000';
  const palette = (mode: Mode): ThemePalette => {
    const values = {} as Record<ThemeRole, string>;
    for (const role of THEME_ROLES) values[role] = clean(draft.palette[mode][role]);
    return values;
  };
  const syntaxHalf = (half: CustomCodeSyntaxHalf): CustomCodeSyntaxHalf => ({
    commentItalic: half.commentItalic ?? true,
    colors: Object.fromEntries(CODE_THEME_ROLES.map((role) => [role, cleanOpaque(half.colors[role])])) as CustomCodeSyntaxHalf['colors'],
  });
  return {
    id: `preview-${draft.id}`,
    name: draft.name,
    palette: { light: palette('light'), dark: palette('dark') },
    ansi: {
      light: draft.ansi.light.map((color) => normalizeThemeColor(color) ?? '#000000'),
      dark: draft.ansi.dark.map((color) => normalizeThemeColor(color) ?? '#000000'),
    },
    ...(draft.syntax ? { syntax: { light: syntaxHalf(draft.syntax.light), dark: syntaxHalf(draft.syntax.dark) } } : {}),
    ...(draft.gradient ? { gradient: draft.gradient } : {}),
  };
}

function editDraft(id: string): Draft | null {
  const theme = currentThemeLibrary().themes.find((entry) => entry.id === id);
  if (!theme) return null;
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description ?? '',
    palette: { light: { ...theme.palette.light }, dark: { ...theme.palette.dark } },
    ansi: { light: [...theme.ansi.light], dark: [...theme.ansi.dark] },
    ...(theme.design ? { design: structuredClone(theme.design) } : {}),
    ...(theme.syntax ? { syntax: structuredClone(theme.syntax) } : {}),
    ...(theme.seed ? { seed: structuredClone(theme.seed) } : {}),
    ...(theme.gradient ? { gradient: structuredClone(theme.gradient) } : {}),
  };
}

/** A new theme on [from]'s colours, under [name] — numbered when the library already has one. */
function newDraft(from: string, name: string): Draft {
  const source = paletteSource(from) ?? paletteSource(DEFAULT_THEME_ID)!;
  const taken = new Set(currentThemeLibrary().themes.map((theme) => theme.name));
  let numbered = name;
  for (let index = 2; taken.has(numbered); index += 1) numbered = `${name} ${index}`;
  return { id: newThemeId(), name: numbered, description: '', ...source };
}

/** A palette to start from: a built-in from the generated table, a plugin's palette, or an existing custom theme. The copy is the user's own: it takes a new custom id when saved. */
function paletteSource(id: string): Pick<Draft, 'palette' | 'ansi' | 'design' | 'syntax' | 'seed' | 'gradient'> | null {
  const plugin = pluginPaletteColors(id);
  if (plugin) {
    return {
      palette: { light: { ...plugin.palette.light }, dark: { ...plugin.palette.dark } },
      ansi: { light: [...plugin.ansi.light], dark: [...plugin.ansi.dark] },
      ...(plugin.design ? { design: structuredClone(plugin.design) } : {}),
      ...(plugin.syntax ? { syntax: structuredClone(plugin.syntax) } : {}),
    };
  }
  const builtin = BUILTIN_THEME_PALETTES[id];
  if (builtin) {
    const ansi = ANSI_BY_THEME[id];
    return {
      palette: { light: { ...builtin.light }, dark: { ...builtin.dark } },
      ansi: { light: [...(ansi?.light ?? [])], dark: [...(ansi?.dark ?? [])] },
    };
  }
  const custom = currentThemeLibrary().themes.find((theme) => theme.id === id);
  if (!custom) return null;
  return {
    palette: { light: { ...custom.palette.light }, dark: { ...custom.palette.dark } },
    ansi: { light: [...custom.ansi.light], dark: [...custom.ansi.dark] },
    ...(custom.design ? { design: structuredClone(custom.design) } : {}),
    ...(custom.syntax ? { syntax: structuredClone(custom.syntax) } : {}),
    ...(custom.seed ? { seed: structuredClone(custom.seed) } : {}),
    ...(custom.gradient ? { gradient: structuredClone(custom.gradient) } : {}),
  };
}

function newThemeId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `custom-${uuid}`;
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const ISSUE_MESSAGES: Record<string, MessageDescriptor> = {
  'is required': msg`必填`,
  'must be a string': msg`必须是文本`,
  'must not be empty': msg`不能为空`,
  'must not contain control characters': msg`不能包含控制字符`,
  'must be #rrggbb or #rrggbbaa': msg`必须是 #rrggbb 或 #rrggbbaa`,
  'must be #rrggbb': msg`必须是 #rrggbb`,
  'must be an object': msg`格式不正确`,
  'must be an array': msg`格式不正确`,
  'is missing': msg`缺少`,
  'is not a theme role': msg`不是有效的颜色角色`,
  'is not a theme field': msg`不是有效的主题字段`,
  'is not a syntax field': msg`不是有效的代码高亮字段`,
  'is not a code role': msg`不是有效的代码高亮角色`,
  'must be a boolean': msg`必须是布尔值`,
  'must be custom- followed by 8–64 lowercase letters, digits or dashes': msg`id 必须是 custom- 加 8–64 位小写字母、数字或连字符`,
};

/** A validation issue as a reader-facing sentence: which field, and what is wrong with it. */
function issueMessage(issue: ThemeValidationIssue): string {
  const path = issue.path.replace(/^themes\[\d+\]\.?/, '');
  const label = fieldLabel(path);
  const atMost = /^must be at most (\d+) characters$/.exec(issue.message);
  const known = ISSUE_MESSAGES[issue.message];
  const message = atMost
    ? i18n._(msg`最多 ${atMost[1]} 个字符`)
    : issue.message.startsWith('must have exactly ')
      ? i18n._(msg`必须是 16 个颜色`)
      : known ? i18n._(known) : issue.message;
  return label ? i18n._(msg`${label}：${message}`) : message;
}

function fieldLabel(path: string): string {
  if (path === 'id') return i18n._(msg`主题 id`);
  if (path === 'name') return i18n._(msg`名称`);
  if (path === 'description') return i18n._(msg({ message: '说明', context: 'settings-theme-description' }));
  if (path === 'palette' || path === 'ansi' || path === 'syntax') return i18n._(msg`颜色`);
  if (path === 'gradient' || path.startsWith('gradient.')) return i18n._(msg`渐变`);
  const palette = /^palette\.(light|dark)\.(.+)$/.exec(path);
  if (palette) {
    const mode = i18n._(palette[1] === 'light' ? msg`浅色` : msg`深色`);
    return `${mode} · ${THEME_ROLE_LABELS[palette[2] as ThemeRole] ?? palette[2]}`;
  }
  const syntax = /^syntax\.(light|dark)\.colors\.(.+)$/.exec(path);
  if (syntax) {
    const mode = i18n._(syntax[1] === 'light' ? msg`浅色` : msg`深色`);
    return `${i18n._(msg`代码高亮`)} · ${mode} · ${CODE_ROLE_LABELS[syntax[2] as CodeThemeRole] ?? syntax[2]}`;
  }
  const ansi = /^ansi\.(light|dark)\[(\d+)\]$/.exec(path);
  if (ansi) {
    const mode = i18n._(ansi[1] === 'light' ? msg`浅色` : msg`深色`);
    const key = THEME_ANSI_KEYS[Number(ansi[2])];
    return `${i18n._(msg`终端`)} · ${mode} · ${key ? THEME_ANSI_LABELS[key] : ansi[2]}`;
  }
  return path;
}
