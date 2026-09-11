const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 180000,
  expect: { timeout: 30000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../../.artifacts/desktop-tests',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
