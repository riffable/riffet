import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { OWNER_AVATAR_PREVIEW_SIDE, colorToHex, composite, parseColor, type OwnerAvatarGenerateRequest, type OwnerAvatarStyle } from '@contracts';
import { IconDices, IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { localizedText } from '@/lib/plugins';

/** A fresh seed: two random words in base36, 14 characters at most. */
function randomSeed(): string {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return Array.from(words, (word) => word.toString(36)).join('');
}

/** The theme's text colour and canvas as `#rrggbb`, which is what a generated picture is drawn with. */
function themeInk(): { ink?: string; paper?: string } {
  const style = getComputedStyle(document.documentElement);
  const paper = parseColor(style.getPropertyValue('--bg'));
  const ink = parseColor(style.getPropertyValue('--fg'));
  if (!paper || !ink) return {};
  const canvas = composite(paper, [255, 255, 255, 1]);
  return { ink: colorToHex([...composite(ink, [...canvas, 1]), 1]), paper: colorToHex([...canvas, 1]) };
}

function previewUrl(style: string, seed: string, colors: { ink?: string; paper?: string }): string {
  const query = new URLSearchParams({ seed });
  if (colors.ink) query.set('ink', colors.ink);
  if (colors.paper) query.set('paper', colors.paper);
  return `/api/owner/avatar-styles/${style.split('/').map(encodeURIComponent).join('/')}/preview?${query}`;
}

/** 随机头像: a dice button that opens the generated styles, each drawn for its own seed (docs/OWNER.md). Absent without styles. */
export function AvatarStylePicker({ name, disabled, onPick }: { name: string | undefined; disabled: boolean; onPick: (request: OwnerAvatarGenerateRequest) => void }) {
  const { t, i18n } = useLingui();
  const [styles, setStyles] = useState<OwnerAvatarStyle[]>([]);
  const [open, setOpen] = useState(false);
  const [seeds, setSeeds] = useState<Record<string, string>>({});
  const [colors, setColors] = useState<{ ink?: string; paper?: string }>({});
  // A server without the plugin, or without the route, simply offers none.
  useEffect(() => { api.ownerAvatarStyles().then((result) => setStyles(result.styles), () => setStyles([])); }, []);
  const shown = styles.filter((style) => !style.needsName || name);
  const reroll = () => setSeeds(Object.fromEntries(shown.map((style) => [style.id, randomSeed()])));
  if (!shown.length) return null;
  const label = t`随机头像`;
  return <Popover open={open} onOpenChange={(next) => { if (next) { setColors(themeInk()); reroll(); } setOpen(next); }}>
    <Tip label={label}><PopoverTrigger asChild><Button size="icon" disabled={disabled} aria-label={label}><IconDices /></Button></PopoverTrigger></Tip>
    <PopoverContent mobileSheet className="w-auto p-3">
      <div className="grid grid-cols-4 gap-2 max-md:grid-cols-3">
        {shown.map((style) => {
          const seed = seeds[style.id];
          const title = localizedText(style.title, [i18n.locale]) ?? style.id;
          return <Tip key={style.id} label={title}>
            <button
              type="button"
              aria-label={title}
              disabled={!seed}
              onClick={() => { setOpen(false); onPick({ style: style.id, seed: seed!, ...colors }); }}
              className="grid size-14 place-items-center overflow-hidden rounded-full bg-active outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-focus"
            >
              {seed && <img src={previewUrl(style.id, seed, colors)} alt="" width={OWNER_AVATAR_PREVIEW_SIDE} height={OWNER_AVATAR_PREVIEW_SIDE} loading="lazy" draggable={false} className="size-full object-cover" />}
            </button>
          </Tip>;
        })}
      </div>
      <Button variant="ghost" size="sm" className="mt-3 w-full" onClick={reroll}><IconRefreshCw />{t`换一批`}</Button>
    </PopoverContent>
  </Popover>;
}
