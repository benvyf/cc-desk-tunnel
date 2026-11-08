const path = require('node:path');
const { readdir, stat, unlink } = require('node:fs/promises');

// Expire the clipboard cache, while keeping every picture referenced by an unsent draft.
async function clearPastedPictures(directory, saved) {
  const drafts = saved && typeof saved === 'object' ? Object.values(saved) : [];
  const referenced = new Set(
    drafts.flatMap((draft) =>
      draft && Array.isArray(draft.attachments)
        ? draft.attachments
            .filter((item) => item && typeof item.path === 'string')
            .map((item) => path.normalize(item.path))
        : [],
    ),
  );
  const text = drafts
    .map((draft) => (typeof draft === 'string' ? draft : draft?.text))
    .filter((value) => typeof value === 'string')
    .join('\n');
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    if (referenced.has(path.normalize(file)) || text.includes(file)) continue;
    const age = Date.now() - (await stat(file).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
    if (age > 7 * 24 * 3600 * 1000) await unlink(file).catch(() => {});
  }
}
module.exports = { clearPastedPictures };
