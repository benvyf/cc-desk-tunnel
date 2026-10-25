# CC SPACE artwork

Original SVGs supplied by the project owner from the `cc-space-S` asset set. Preserve the S geometry and aspect ratio. `Brand.tsx` embeds the same two paths, using the supplied clay colors in light mode and ivory/clay colors in dark mode. Uppercase CC SPACE is live text so interface font sizing and assistive technology work normally.

The desktop application icon uses `s3-icon-clay.svg`. Dedicated 16px favicon and 32px tray images give the S more space than shrinking the full application tile. macOS template PNGs contain the monochrome S with transparent backgrounds, at 18px and 36px.

Regenerate the checked-in PNGs with `node scripts/generate-brand-icons.mjs`. The script uses Playwright's Chromium; set `PLAYWRIGHT_CHANNEL=chrome` to use an installed Chrome. It does not change the vector sources or contact a service.

Display branding is CC SPACE. The existing app ID, profile directory, internal package/deployment names, repository URL and signed installer artifact filenames are retained for upgrades from the earlier CC Desk Tunnel client.

The Windows NSIS include retains its internal APP_FILENAME directory token as CC Desk Tunnel; PRODUCT_FILENAME and shortcuts remain CC SPACE. This prevents the assisted directory page from appending a new folder during an upgrade, which would change the directory-based managed update identity. With cached NSIS available, set NSIS_BRANDING_COMPILER to makensis.exe and run `node --test apps/desktop/test-main/installer-branding.test.mjs` to exercise the builder's actual directory callback without installing anything.

The packaged profile stays in the legacy CC Desk Tunnel folder. On macOS/Linux, Electron keeps its previous internal name until `ready`, after OS encryption identities have been captured; this preserves remembered credentials while later UI and menus use CC SPACE. The Linux manifest also retains `cc-desk-tunnel.desktop` to match the launcher. These OS-specific paths are covered with initialization tests; actual Keychain/keyring integration still needs testing on those platforms.
