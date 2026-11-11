import { useState } from 'react';
import { ownerMonogram } from '@contracts';
import { cn } from '@/lib/utils';
import { IconUser } from './icons';

/**
 * The owner's avatar (docs/OWNER.md): the picture, else the name's first character on a neutral
 * surface, else a generic person. `size` is in pixels.
 */
export function OwnerAvatar({ owner, size = 28, className }: { owner: { name?: string; avatar?: { url: string } } | undefined; size?: number; className?: string }) {
  const [failedURL, setFailedURL] = useState<string>();
  const url = owner?.avatar?.url;
  const monogram = ownerMonogram(owner?.name);
  return (
    <span style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} className={cn('grid shrink-0 select-none place-items-center overflow-hidden rounded-full bg-active font-medium leading-none text-fg-2', className)}>
      {url && url !== failedURL ? <img src={url} alt="" draggable={false} className="size-full object-cover" onError={() => setFailedURL(url)} /> : monogram ?? <IconUser style={{ width: size * 0.55, height: size * 0.55 }} />}
    </span>
  );
}
