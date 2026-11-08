import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: './apps/desktop/test',
  testMatch: [
    'multi-device-development.spec.ts',
    'multi-device-sidebar.spec.ts',
    'open-project-dialog.spec.ts',
    'terminal-projects.spec.ts',
    'multi-device-electron.spec.ts',
  ],
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:15223',
    channel: 'msedge',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'node scripts/dev.mjs',
    url: 'http://127.0.0.1:15223',
    reuseExistingServer: false,
    env: {
      PROXY_PORT: '18923',
      UI_PORT: '15223',
      PROXY_RUNTIME_DIR: resolve('.local/multi-device-ui'),
    },
  },
});
