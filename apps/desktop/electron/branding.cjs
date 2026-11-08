const path = require('node:path');
const { mkdirSync } = require('node:fs');
const brand = require('../brand.json');

// The display name changed; the profile and installer identity continue the existing installation.
// Explicit test/user profiles and development checkouts keep their own directories.
function configureBrand(app, platform = process.platform) {
  const directory =
    app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')
      ? path.join(app.getPath('appData'), brand.legacyProfileName)
      : app.getPath('userData');
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
  if (platform === 'win32') {
    app.setName(brand.name);
  } else {
    const originalName = app.getName();
    const production =
      app.isPackaged && [brand.name, brand.legacyProfileName].includes(originalName);
    // Electron 44 captures POSIX keyring/Keychain names before ready. Changing the name
    // sooner would make remembered tokens unreadable; development/test apps keep their own keys.
    app.setName(production ? brand.legacyProfileName : originalName);
    app.once('ready', () => app.setName(brand.name));
  }
  return directory;
}

module.exports = { ...brand, configureBrand };
