
// A wide screenshot remains readable; tall screenshots keep their full aspect ratio.
const MAX_WIDTH = 2048;
const MAX_INPUT_PIXELS = 64 * 1024 * 1024;

interface ShareImage {
  data: Buffer;
  width?: number;
  height?: number;
}

function animatedPng(data: Buffer): boolean {
  // libvips may read only the first frame of APNG. Preserve its animation verbatim.
  for (let offset = 8; offset + 12 <= data.length;) {
    const size = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += size + 12;
  }
  return false;
}

/** Optimize the exported copy only. Unsupported, animated and damaged images remain intact. */
export async function optimizeShareImage(data: Buffer, mimeType: string): Promise<ShareImage> {
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') return { data };
  if (mimeType === 'image/png' && animatedPng(data)) return { data };
  try {
    const { default: sharp } = await import('sharp');
    const image = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) return { data };
    const resized = image.autoOrient().resize({ width: MAX_WIDTH, withoutEnlargement: true });
    const encoded = mimeType === 'image/png'
      ? resized.png({ compressionLevel: 9 })
      : resized.jpeg({ quality: 85 });
    const result = await encoded.toBuffer({ resolveWithObject: true });
    return result.data.length < data.length
      ? { data: result.data, width: result.info.width, height: result.info.height }
      : { data, width: metadata.autoOrient.width, height: metadata.autoOrient.height };
  } catch {
    // A codec/size limit should not turn a previously usable attachment into a missing image.
    return { data };
  }
}
