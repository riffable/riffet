import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconFolderOpen, IconPlus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Field, Input, Spinner } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { errorMessage, tildePath } from '@/lib/utils';
import { hostInfo } from '@/lib/platform';
import { DirectoryPicker } from './DirectoryPicker';
import { byRecentUse, FavoriteStar, favoriteName, useFolderFavorites } from './FolderFavorites';

export function AddProjectDialog({ open, onOpenChange, onSubmit, onError }: { open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (input: { cwd: string; name?: string }) => Promise<boolean>; onError?: (message: string) => void }) {
  const { t } = useLingui();
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const quickPicks = byRecentUse(useFolderFavorites(undefined, open).favorites.filter((favorite) => favorite.exists));

  /** A favorite is added in one click; the server stamps it as used when the project opens. */
  const submit = async (target = cwd.trim()) => {
    if (!target || busy) return;
    setBusy(true);
    try {
      if (await onSubmit({ cwd: target, ...(name.trim() ? { name: name.trim() } : {}) })) { setCwd(''); setName(''); }
    } finally { setBusy(false); }
  };

  /**
   * 浏览… asks the server host for its native folder chooser, which is the only way to
   * obtain a real absolute path. Hosts without a drivable chooser (or where it fails)
   * fall back to the in-app browser so the button always does something useful. The chooser
   * appears on the server's screen, so a reader on another machine gets the in-app browser.
   */
  const browseNative = async () => {
    if (picking) return;
    if (!hostInfo().local) { setPickerOpen(true); return; }
    setPicking(true);
    try {
      const result = await api.pickDirectory({ prompt: t`选择项目目录`, ...(cwd.trim() ? { defaultPath: cwd.trim() } : {}) });
      if (result.cancelled) return;
      if (result.path) { setCwd(result.path); return; }
      setPickerOpen(true);
    } catch (error) {
      const message = errorMessage(error, t`无法打开系统目录选择器`);
      if (onError) onError(message); else console.error(message);
      setPickerOpen(true);
    } finally { setPicking(false); }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
        <DialogContent mobileSheet aria-describedby={undefined}>
          <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <DialogHeader>
              <DialogTitle><Trans>添加项目</Trans></DialogTitle>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4 pt-1">
              <Field label={t`目录路径`}>
                <div className="flex items-center gap-2 max-md:flex-col max-md:items-stretch">
                  <Input className="font-mono" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/Users/you/code/project" />
                  <Button type="button" variant="secondary" className="max-md:h-11" disabled={picking} onClick={() => void browseNative()}>{picking ? <Spinner className="text-current" /> : <IconFolderOpen />}<Trans>浏览…</Trans></Button>
                </div>
              </Field>
              {quickPicks.length > 0 && (
                // Not a <Field>: that is a <label>, and a click on its blank space would press the first chip.
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-sm font-medium text-fg"><Trans>收藏的目录</Trans></span>
                  <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                    {quickPicks.map((favorite) => (
                      <button key={favorite.id} type="button" disabled={busy} title={favorite.path} onClick={() => void submit(favorite.path)} className="flex h-7 max-w-full items-center gap-1.5 rounded-md bg-subtle px-2 text-xs text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-60 max-md:h-10 max-md:px-3">
                        <FavoriteStar className="size-3" />
                        <span className="min-w-0 truncate">{favoriteName(favorite)}</span>
                        <span className="hidden min-w-0 max-w-40 truncate font-mono text-2xs text-fg-4 sm:inline">{tildePath(favorite.path)}</span>
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-fg-3"><Trans>直接添加为项目</Trans></span>
                </div>
              )}
              <Field label={t`显示名称`} hint={t`留空时使用目录名`}><Input className="max-md:h-11" value={name} onChange={(event) => setName(event.target.value)} /></Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}><Trans context="workbench-cancel-action">取消</Trans></Button>
              <Button type="submit" variant="primary" disabled={!cwd.trim() || busy}>{busy ? <Spinner className="text-current" /> : <IconPlus />}<Trans>添加</Trans></Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={cwd.trim() || undefined}
        onPick={(path) => setCwd(path)}
        onError={(message) => onError?.(message) ?? console.error(message)}
      />
    </>
  );
}
