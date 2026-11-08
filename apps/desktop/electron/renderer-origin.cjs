const { fileURLToPath } = require('node:url');

// IPC belongs to the primary application's main frame, not to a URL scheme.
function isTrustedRenderer(event, contents, entry) {
  try {
    if (
      !contents ||
      contents.isDestroyed() ||
      event.sender !== contents ||
      !event.senderFrame ||
      event.senderFrame !== contents.mainFrame
    )
      return false;
    const url = new URL(event.senderFrame.url);
    return url.protocol === 'file:' && fileURLToPath(url) === entry;
  } catch {
    return false;
  }
}
module.exports = { isTrustedRenderer };
