import { useAppearanceBackground } from '@/lib/appearance';

/**
 * A plugin's background, laid over the workbench like a sheet of paper. It takes no room and no
 * pointer, so the layout stays as it was and the main area stays full-bleed; the image's own
 * transparency and the declared opacity decide how much of the surfaces under it shows.
 */
export function BackdropLayer({ url, opacity, fit }: { url: string; opacity: number; fit: 'cover' | 'tile' }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-(--z-dock)"
      style={{
        opacity,
        backgroundImage: `url(${JSON.stringify(url)})`,
        ...(fit === 'tile' ? { backgroundRepeat: 'repeat' } : { backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }),
      }}
    />
  );
}

export function AppearanceBackdrop() {
  const background = useAppearanceBackground();
  return background ? <BackdropLayer url={background.asset.url} opacity={background.opacity} fit={background.fit} /> : null;
}
