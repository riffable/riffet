import { useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  DEFAULT_AGENT_MEMBER_ID,
  OWNER_AVATAR_TYPES,
  ownerMonogram,
  type AgentMember,
  type AgentMemberAvatar,
  type AgentMemberAvatarInput,
  type OwnerAvatarGenerateRequest,
  type OwnerAvatarType,
} from '@contracts';
import { IconBot } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { squareAvatar } from '@/lib/avatar-upload';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { AvatarStylePicker, avatarStylePreviewUrl } from '../settings/AvatarStylePicker';

export type MemberAvatarDraft =
  | { kind: 'none' }
  | { kind: 'existing'; avatar: AgentMemberAvatar }
  | { kind: 'image'; type: OwnerAvatarType; data: string; previewUrl: string }
  | { kind: 'generated'; request: OwnerAvatarGenerateRequest; previewUrl: string };

export function avatarDraftFromMember(avatar: AgentMemberAvatar | undefined): MemberAvatarDraft {
  return avatar ? { kind: 'existing', avatar } : { kind: 'none' };
}

export function avatarInputFromDraft(draft: MemberAvatarDraft): AgentMemberAvatarInput | null {
  if (draft.kind === 'none') return null;
  if (draft.kind === 'image') return { kind: 'image', type: draft.type, data: draft.data };
  if (draft.kind === 'generated') return { kind: 'generated', request: draft.request };
  if (draft.avatar.kind === 'emoji') return { kind: 'emoji', value: draft.avatar.value };
  return null;
}

/**
 * Displays a team member's avatar: uploaded/generated picture, saved emoji, name monogram, or bot mark.
 * `size` is in pixels (matching `OwnerAvatar`).
 */
export function MemberAvatar({ member, draft, name, isDefault, size = 20, className }: {
  member?: Pick<AgentMember, 'id' | 'name' | 'avatar'>;
  draft?: MemberAvatarDraft;
  name?: string;
  isDefault?: boolean;
  size?: number;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const resolvedName = name ?? member?.name;
  const defaultMember = isDefault ?? member?.id === DEFAULT_AGENT_MEMBER_ID;

  let imageUrl: string | undefined;
  let emoji: string | undefined;
  if (draft) {
    if (draft.kind === 'image' || draft.kind === 'generated') imageUrl = draft.previewUrl;
    else if (draft.kind === 'existing') {
      if (draft.avatar.kind === 'image') imageUrl = draft.avatar.url;
      else emoji = draft.avatar.value;
    }
  } else if (member?.avatar) {
    if (member.avatar.kind === 'image') imageUrl = member.avatar.url;
    else emoji = member.avatar.value;
  }

  if (imageUrl && imageUrl !== failedUrl) {
    return (
      <span
        style={{ width: size, height: size }}
        className={cn('grid shrink-0 select-none place-items-center overflow-hidden rounded-full bg-active', className)}
      >
        <img src={imageUrl} alt="" draggable={false} className="size-full object-cover" onError={() => setFailedUrl(imageUrl)} />
      </span>
    );
  }
  if (emoji) {
    return (
      <span
        style={{ width: size, height: size, fontSize: Math.round(size * 0.68) }}
        className={cn('grid shrink-0 select-none place-items-center rounded-full leading-none', className)}
      >
        {emoji}
      </span>
    );
  }
  const monogram = defaultMember ? undefined : ownerMonogram(resolvedName);
  if (monogram) {
    return (
      <span
        style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
        className={cn('grid shrink-0 select-none place-items-center rounded-full bg-active font-medium leading-none text-fg-2', className)}
      >
        {monogram}
      </span>
    );
  }
  return (
    <span
      style={{ width: size, height: size }}
      className={cn('grid shrink-0 select-none place-items-center rounded-full text-fg-3', size >= 32 && 'bg-active', className)}
    >
      <IconBot style={{ width: Math.round(size * 0.72), height: Math.round(size * 0.72) }} />
    </span>
  );
}

/**
 * Reuses the exact Settings -> Profile avatar controls: circular preview, image upload,
 * plugin-powered random avatar (`AvatarStylePicker`), and remove.
 */
export function MemberAvatarControls({ value, name, isDefault, disabled, onChange }: {
  value: MemberAvatarDraft;
  name?: string;
  isDefault?: boolean;
  disabled?: boolean;
  onChange: (next: MemberAvatarDraft) => void;
}) {
  const { t } = useLingui();
  const fileRef = useRef<HTMLInputElement>(null);
  const trimmedName = name?.trim() || undefined;

  const pickFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    try {
      const encoded = await squareAvatar(file);
      onChange({ kind: 'image', type: encoded.type, data: encoded.data, previewUrl: `data:${encoded.type};base64,${encoded.data}` });
    } catch {
      toast.error(t`无法读取这张图片`);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <MemberAvatar draft={value} name={trimmedName} isDefault={isDefault} size={56} className="ring-1 ring-line" />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={OWNER_AVATAR_TYPES.join(',')}
          hidden
          onChange={(event) => { void pickFile(event.target.files?.[0]); }}
        />
        <Button type="button" disabled={disabled} onClick={() => fileRef.current?.click()}>
          <Trans>更换头像</Trans>
        </Button>
        <AvatarStylePicker
          name={trimmedName}
          previewName={trimmedName}
          disabled={Boolean(disabled)}
          onPick={(request) => {
            const previewUrl = avatarStylePreviewUrl(
              request.style,
              request.seed,
              { ...(request.ink ? { ink: request.ink } : {}), ...(request.paper ? { paper: request.paper } : {}) },
              trimmedName,
            );
            onChange({ kind: 'generated', request, previewUrl });
          }}
        />
        {value.kind !== 'none' && (
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange({ kind: 'none' })}>
            <Trans>移除</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}
