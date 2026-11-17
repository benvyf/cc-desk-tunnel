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
