import type { AppearanceBackgroundFit, AppearanceBackgroundPlacement, AppearanceBackgroundPosition } from '@contracts';
import { useAppearanceBackground } from '@/lib/appearance';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const POSITION_CSS: Record<AppearanceBackgroundPosition, string> = {
  center: 'center',
  top: 'top center',
  bottom: 'bottom center',
  left: 'center left',
  right: 'center right',
  'top-left': 'top left',
  'top-right': 'top right',
  'bottom-left': 'bottom left',
  'bottom-right': 'bottom right',
};

/**
 * A plugin's background layer. `overlay` sits over the workbench like a sheet of translucent paper
 * grain; `underlay` sits behind the shell surfaces so wallpaper or corner illustrations stay
 * visible without covering text. Neither takes layout space or pointer events.
 */
export function BackdropLayer({
  url,
  opacity,
  fit,
  position = 'center',
  placement = 'overlay',
  className,
}: {
  url: string;
  opacity: number;
  fit: AppearanceBackgroundFit;
  position?: AppearanceBackgroundPosition;
  placement?: AppearanceBackgroundPlacement;
  className?: string;
}) {
  const backgroundPosition = POSITION_CSS[position];
  const fitStyle = fit === 'tile'
    ? { backgroundRepeat: 'repeat', backgroundPosition }
    : fit === 'contain'
      ? { backgroundSize: 'contain', backgroundPosition, backgroundRepeat: 'no-repeat' }
      : { backgroundSize: 'cover', backgroundPosition, backgroundRepeat: 'no-repeat' };
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0', placement === 'overlay' && 'z-(--z-dock)', className)}
      style={{
        opacity,
        backgroundImage: `url(${JSON.stringify(url)})`,
        ...fitStyle,
      }}
    />
  );
}

export function AppearanceBackdrop({ placement = 'overlay' }: { placement?: AppearanceBackgroundPlacement }) {
  const background = useAppearanceBackground();
  const { resolved } = useTheme();
  if (!background || (background.placement ?? 'overlay') !== placement) return null;
  const url = resolved === 'dark' ? (background.darkAsset?.url ?? background.asset.url) : background.asset.url;
  return (
    <BackdropLayer
      url={url}
      opacity={background.opacity}
      fit={background.fit}
      position={background.position}
      placement={placement}
    />
  );
}
