import { OWNER_AVATAR_MAX_BYTES, OWNER_AVATAR_SIDE, type OwnerAvatarType } from '@contracts';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      if (comma < 0) { reject(new Error('encode failed')); return; }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('encode failed'));
    reader.readAsDataURL(blob);
  });
}

/** Crops an image file to its centered square and scales it to the avatar budget, preferring webp. */
export async function squareAvatar(file: File): Promise<{ type: OwnerAvatarType; data: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error('empty image');
    const target = Math.min(side, OWNER_AVATAR_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = target;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, target, target);
    const encode = (type: OwnerAvatarType, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    // A browser that cannot encode webp answers with png instead, which a photo can push past the limit; jpeg then
    // steps its quality down, over white so a transparent corner does not turn black.
    let blob = await encode('image/webp', 0.9) ?? await encode('image/png');
    if (blob && blob.size > OWNER_AVATAR_MAX_BYTES) {
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#fff';
      context.fillRect(0, 0, target, target);
      for (const quality of [0.9, 0.8, 0.7, 0.6]) {
        blob = await encode('image/jpeg', quality);
        if (!blob || blob.size <= OWNER_AVATAR_MAX_BYTES) break;
      }
    }
    if (!blob) throw new Error('encode failed');
    const type: OwnerAvatarType = blob.type === 'image/webp' ? 'image/webp' : blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return { type, data: await blobToBase64(blob) };
  } finally {
    bitmap.close();
  }
}
