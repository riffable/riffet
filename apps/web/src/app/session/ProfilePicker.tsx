import { useLingui } from '@lingui/react/macro';
import type { NativeBackendProfile } from '@contracts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Which provider profile of the chosen agent a launch draws models from, in the same custom
 * menu as the other launch pickers (a native `<select>` would break the row's look).
 * An unset value is the backend's default profile.
 */
export function ProfilePicker({ profiles, value, disabled, onChange }: {
  profiles: NativeBackendProfile[];
  value?: string;
  disabled?: boolean;
  onChange: (profileId: string | undefined) => void;
}) {
  const { t } = useLingui();
  const current = profiles.find((profile) => profile.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={t({ message: '配置', context: 'session-profile-select' })}
        className={cn(
          'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-sm text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg',
        )}
      >
        <span className="max-w-40 truncate">{current?.name ?? t`默认配置`}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(next) => onChange(next || undefined)}>
          <DropdownMenuRadioItem value="" textValue={t`默认配置`}>
            <span className="flex min-w-0 flex-col py-1"><span>{t`默认配置`}</span></span>
          </DropdownMenuRadioItem>
          {profiles.map((profile) => (
            <DropdownMenuRadioItem key={profile.id} value={profile.id} textValue={profile.name}>
              <span className="flex min-w-0 flex-col py-1">
                <span>{profile.name}</span>
                {profile.description && <span className="text-xs text-fg-3">{profile.description}</span>}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
