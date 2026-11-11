import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import UTIF from 'utif';
import { escapeHtml } from './document.js';
import { extensionOf } from './formats.js';
import type { PreviewFragment, PreviewParseInput } from './parse.js';

const PIXELS = 4_000_000;
function checkSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > PIXELS) throw new Error('图片尺寸超过预览限制');
}
function pngImage(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, name: string): string {
  checkSize(width, height);
  if (rgba.byteLength !== width * height * 4) throw new Error('图片像素数据不完整');
  const image = new PNG({ width, height });
  image.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const png = PNG.sync.write(image);
  return `<img src="data:image/png;base64,${png.toString('base64')}" width="${width}" height="${height}" alt="${escapeHtml(name)}">`;
}

export async function imagePreview({ data, name }: PreviewParseInput): Promise<PreviewFragment> {
  const extension = extensionOf(name);
  const buffer = Buffer.from(data);
  const images: string[] = [];
  if (extension === 'tif' || extension === 'tiff') {
    const pages = UTIF.decode(buffer);
    let pixels = 0;
    for (const page of pages.slice(0, 8)) {
      const width = Number((page.t256 as number[] | undefined)?.[0] ?? page.width);
      const height = Number((page.t257 as number[] | undefined)?.[0] ?? page.height);
      checkSize(width, height);
      pixels += width * height;
      if (pixels > PIXELS) { images.push('<p class="muted">仅显示前一部分页面</p>'); break; }
      UTIF.decodeImage(buffer, page);
      images.push(pngImage(page.width, page.height, UTIF.toRGBA8(page), name));
    }
    if (pages.length > 8) images.push('<p class="muted">仅显示前 8 页</p>');
  } else if (extension === 'heic' || extension === 'heif') {
    // The library exposes dimensions before pixel allocation through all(); release its native
    // decoder even if the image is rejected by the pixel budget or PNG encoding fails.
    const decode = createRequire(import.meta.url)('heic-decode') as {
      all(input: { buffer: Buffer }): Promise<Array<{ width: number; height: number; decode(): Promise<{ width: number; height: number; data: Uint8ClampedArray }> }> & { dispose(): void }>;
    };
    const pictures = await decode.all({ buffer });
    try {
      const first = pictures[0];
      if (!first) throw new Error('未找到图片');
      checkSize(first.width, first.height);
      const image = await first.decode();
      images.push(pngImage(image.width, image.height, image.data, name));
    } finally { pictures.dispose(); }
  } else throw new Error('此图片格式使用原始图片预览');
  if (!images.length) throw new Error('未找到图片');
  return { body: `<main class="media">${images.join('')}</main>` };
}
