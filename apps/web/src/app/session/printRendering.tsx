import { createContext, useState } from 'react';
import { Trans } from '@lingui/react/macro';

/** A frozen print document renders every resource, including content outside the viewport. */
export const PrintRenderingContext = createContext(false);

/** Print the complete image, without thumbnail crops, animations or lightbox controls. */
export function PrintImage({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span className="share-print-missing"><Trans>图片无法加载 · {name}</Trans></span>
    : <img className="share-print-image" src={src} alt={name} loading="eager" decoding="sync" onError={() => setFailed(true)} />;
}
