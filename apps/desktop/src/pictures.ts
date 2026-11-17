export type ToolPicture = { type: string; data: string };

// A tool that looked at a picture (Read on an image, a screenshot an MCP tool took) answers with content blocks,
// which the service passes on as their JSON. The pictures are shown as pictures and the words stay text; any
// other output is left as it is.
export type Pictures = { text: string; pictures: ToolPicture[] } | null;
export function toolPictures(output: string): Pictures {
  if (!output.startsWith('[') || !output.includes('"image"')) return null;
  return parsePictures(output);
}
// The transcript is drawn anew from the session's events on every event, but each event is kept as the one
// object: its pictures are read once, by that object, and are the same objects at every drawing. They go
// with the event when the session's history is let go.
const read = new WeakMap<object, Pictures>();
export function resultPictures(result: { output: string }): Pictures {
  if (!read.has(result)) read.set(result, toolPictures(result.output));
  return read.get(result)!;
}
// Every picture the tools of a step or a turn looked at, in order.
export function picturesOf(items: readonly { kind: string; pictures?: Pictures }[]): ToolPicture[] {
  return items.flatMap((item) => (item.kind === 'tool' && item.pictures?.pictures) || []);
}
function parsePictures(output: string): Pictures {
  let blocks: unknown;
  try {
    blocks = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(blocks)) return null;
  const text: string[] = [];
  const pictures: ToolPicture[] = [];
  for (const block of blocks as {
    type?: unknown;
    text?: unknown;
    source?: { type?: unknown; media_type?: unknown; data?: unknown };
  }[]) {
    const source = block?.source;
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (
      block?.type === 'image' &&
      source?.type === 'base64' &&
      typeof source.media_type === 'string' &&
      /^image\/(?:png|jpeg|gif|webp)$/.test(source.media_type) &&
      typeof source.data === 'string'
    )
      pictures.push({ type: source.media_type, data: source.data });
    else return null;
  }
  return pictures.length ? { text: text.join('\n'), pictures } : null;
}
// A picture's address is made once: it is megabytes long, and a thumbnail is drawn again every second.
const urls = new WeakMap<ToolPicture, string>();
export function pictureUrl(picture: ToolPicture) {
  let url = urls.get(picture);
  if (url === undefined) urls.set(picture, (url = `data:${picture.type};base64,${picture.data}`));
  return url;
}
// What stands for a picture in text: its type and about how large it is.
export const pictureNote = (picture: ToolPicture) =>
  `[图片 ${picture.type} · ${Math.max(1, Math.round((picture.data.length * 3) / 4 / 1024))} KB]`;

// The size a picture says it is in its own header, read from its first bytes without decoding it: room is kept
// at the right width before its thumbnail is made, so nothing moves when it arrives. PNG, JPEG, GIF and WebP;
// anything else, or a header that cannot be read, gives null and a 4:3 place.
const sizes = new WeakMap<ToolPicture, { width: number; height: number } | null>();
export function pictureSize(picture: ToolPicture) {
  if (sizes.has(picture)) return sizes.get(picture)!;
  let size: { width: number; height: number } | null = null;
  try {
    const head = Uint8Array.from(
      atob(picture.data.slice(0, 87384).replace(/=+$/, '').slice(0, 87380)),
      (c) => c.charCodeAt(0),
    );
    size = headerSize(head);
  } catch {
    size = null;
  }
  sizes.set(picture, size);
  return size;
}
export function headerSize(b: Uint8Array): { width: number; height: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const valid = (width: number, height: number) =>
    width > 0 && height > 0 && width < 100000 && height < 100000 ? { width, height } : null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return valid(u32(16), u32(20));
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return valid(le16(6), le16(8));
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45
  ) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X')
      return valid(
        1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      );
    if (kind === 'VP8 ') return valid(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (kind === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      // Start of frame, except DHT (C4), JPG (C8) and DAC (CC), carries the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return valid(u16(i + 7), u16(i + 5));
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

// Small copies for every thumbnail: a picture is decoded once, at full size, to make a copy at least 128px on its
// short side (at most 768px on its long one), and every thumbnail of it uses that copy. A thumbnail of the full picture would decode it again,
// at full size, for each place it stands: tens of screenshots would hold hundreds of megabytes. Only the viewer
// decodes the picture itself. Two are made at a time, so a run of screenshots does not stall the window.
export type Thumbnail = { url: string; width: number; height: number };
const thumbnails = new WeakMap<ToolPicture, Promise<Thumbnail>>();
const made = new WeakMap<ToolPicture, Thumbnail>();
const queue: (() => void)[] = [];
let making = 0;
function slot<T>(work: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      making++;
      work()
        .then(resolve, reject)
        .finally(() => {
          making--;
          queue.shift()?.();
        });
    };
    if (making < 2) run();
    else queue.push(run);
  });
}
export const thumbnailHeight = 128;
// A picture's bytes. Read from its own data, not fetched: the window's policy lets no fetch reach a data: address.
export function pictureBlob(picture: ToolPicture) {
  const text = atob(picture.data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return new Blob([bytes], { type: picture.type });
}
const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
async function makeThumbnail(picture: ToolPicture): Promise<Thumbnail> {
  const bitmap = await createImageBitmap(pictureBlob(picture));
  try {
    const { width, height } = bitmap;
    // The short side at least 128px, so that a cell of any proportions is filled without enlarging the copy (a
    // long screenshot is not reduced to a sliver); the long side at most 768px. Never larger than the picture.
    let scale = Math.min(1, thumbnailHeight / Math.min(width, height));
    if (Math.max(width, height) * scale > 768) scale = 768 / Math.max(width, height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, w, h);
    const small = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
    // A data: address of a few kilobytes: the window's policy shows data: pictures, and no blob: ones.
    return { url: await dataUrl(small), width, height };
  } finally {
    bitmap.close();
  }
}
export function thumbnail(picture: ToolPicture): Promise<Thumbnail> {
  let pending = thumbnails.get(picture);
  if (!pending) {
    pending = slot(() => makeThumbnail(picture)).then((value) => {
      made.set(picture, value);
      return value;
    });
    thumbnails.set(picture, pending);
  }
  return pending;
}
// The copy if it is made already, for drawing it at once.
export const madeThumbnail = (picture: ToolPicture) => made.get(picture) ?? null;
