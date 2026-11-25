import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { OWNER_AVATAR_HISTORY_MAX, OWNER_AVATAR_TYPES, OWNER_NAME_MAX } from '@contracts';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { IconTrash2 } from '@/components/icons';
import { Input } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { squareAvatar } from '@/lib/avatar-upload';
import { errorMessage } from '@/lib/utils';
import { AvatarStylePicker } from './AvatarStylePicker';
import { useLists, useStores } from '../state/stores';
import { SettingsGroup as Group, SettingsRow as Row } from './SettingsLayout';

/** 个人资料: the owner's name and avatar, one per server (docs/OWNER.md). */
export function ProfileSection({ onError }: { onError: (message: string) => void }) {
  const { t } = useLingui();
  const { lists } = useStores();
  const owner = useLists((state) => state.owner);
  const saved = owner?.name ?? '';
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const editing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ sha256: string; x: number; y: number } | undefined>();
  // Another device's rename lands unless this field is being typed in.
  useEffect(() => { if (!editing.current) setDraft(saved); }, [saved]);
  const run = async (action: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { onError(errorMessage(error, fallback)); }
    finally { setBusy(false); }
  };
  const commitName = () => {
    editing.current = false;
    const name = draft.trim();
    setDraft(name);
    if (name === saved) return;
    void run(async () => { lists.setOwner(await api.updateOwner({ name: name || null })); }, t`无法保存名称`);
  };
  const pickAvatar = (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    void run(async () => {
      let upload: Awaited<ReturnType<typeof squareAvatar>>;
      try { upload = await squareAvatar(file); }
      catch { onError(t`无法读取这张图片`); return; }
      lists.setOwner(await api.uploadOwnerAvatar(upload));
    }, t`无法保存头像`);
  };
  return <Group note={<Trans>所有连接这台服务器的设备共用</Trans>}>
    <div className="flex items-center gap-4 py-4">
      <OwnerAvatar owner={owner} size={56} />
      <div className="flex items-center gap-2">
        <input ref={fileInput} type="file" accept={OWNER_AVATAR_TYPES.join(',')} hidden onChange={(event) => pickAvatar(event.target.files?.[0])} />
        <Button disabled={busy} onClick={() => fileInput.current?.click()}><Trans>更换头像</Trans></Button>
        <AvatarStylePicker name={saved.trim() || undefined} disabled={busy} onPick={(request) => void run(async () => { lists.setOwner(await api.generateOwnerAvatar(request)); }, t`无法保存头像`)} />
        {owner?.avatar && <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { lists.setOwner(await api.removeOwnerAvatar()); }, t`无法移除头像`)}><Trans>移除</Trans></Button>}
      </div>
    </div>
    {!!owner?.history?.length && <Row title={<Trans>历史头像</Trans>}>
      <div className="flex flex-wrap justify-end gap-2 max-md:justify-start">
        {owner.history.slice(0, OWNER_AVATAR_HISTORY_MAX).map((avatar) => (
          <button
            key={avatar.sha256}
            type="button"
            disabled={busy}
            onClick={() => void run(async () => { lists.setOwner(await api.restoreOwnerAvatar(avatar.sha256)); }, t`无法保存头像`)}
            onContextMenu={(event) => { event.preventDefault(); setMenu({ sha256: avatar.sha256, x: event.clientX, y: event.clientY }); }}
            className="rounded-full hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          >
            <OwnerAvatar owner={{ avatar }} size={36} />
          </button>
        ))}
      </div>
    </Row>}
    {menu && (
      <DropdownMenu open onOpenChange={(open) => { if (!open) setMenu(undefined); }}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu.x, top: menu.y }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={0}>
          <DropdownMenuItem variant="danger" onSelect={() => void run(async () => { lists.setOwner(await api.deleteOwnerAvatarHistory(menu.sha256)); }, t`无法保存头像`)}><IconTrash2 /><Trans context="settings-delete-action">删除</Trans></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )}
    <Row title={<label htmlFor="owner-name"><Trans>名称</Trans></label>}>
      <Input
        id="owner-name"
        value={draft}
        maxLength={OWNER_NAME_MAX}
        disabled={busy}
        onFocus={() => { editing.current = true; }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}
        className="w-56 max-md:w-full"
      />
    </Row>
  </Group>;
}
