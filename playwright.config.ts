import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    timeout: 30000,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:8791',
        channel: process.env.PW_CHANNEL || 'msedge',
        viewport: { width: 1280, height: 720 },
        locale: 'zh-CN',
    },
    globalSetup: require.resolve('./e2e/global-setup'),
    outputDir: './e2e/.artifacts',
    snapshotDir: './e2e/__screenshots__',
    expect: {
        timeout: 5000,
        toHaveScreenshot: { maxDiffPixelRatio: 0.05 },
    },
});
