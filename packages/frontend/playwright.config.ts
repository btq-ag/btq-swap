import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:4179', headless: true,
    launchOptions: process.env.BTQ_TEST_CHROME ? { executablePath: process.env.BTQ_TEST_CHROME } : {} },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 4179', url: 'http://127.0.0.1:4179', reuseExistingServer: false },
});
