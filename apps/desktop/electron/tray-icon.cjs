const path = require('node:path');

// NativeImage loads the matching @2x representation for Retina menu bars.
function spaceTemplate(nativeImage) {
  const image = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
  image.setTemplateImage(true);
  return image;
}
module.exports = { spaceTemplate };
