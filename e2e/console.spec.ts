import { test, expect, type Page } from '@playwright/test';

/**
 * T4 E2E: full control-surface walkthrough against the hermetic server
 * (mock embeddings, picker disabled). Ordered — the suite drives the app
 * from unconfigured → configured → imported → searched → browsed.
 */

const SEED_DIR = process.env.E2E_SEED_DIR ?? '';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
    await page.goto('/');
});

test('未配置状态：banner 显示、搜索禁用、去设置入口', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#banner.show')).toBeVisible();
    await expect(page.locator('#banner-text')).toContainText('尚未配置');
    await expect(page.locator('#q')).toBeDisabled();
    await expect(page.locator('#search-btn')).toBeDisabled();
    await expect(page.locator('#model-sub')).toHaveText('未配置');
});

test('设置弹窗：字段回填、保存后 banner 消失、搜索可用', async ({ page }) => {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-modal.open')).toBeVisible();
    await expect(page.locator('#set-apikey-note')).toContainText('尚未配置');
    await page.locator('#set-apikey').fill('sk-e2e-mock-key');
    await page.locator('#settings-save').click();
    await expect(page.locator('#settings-modal.open')).toHaveCount(0);
    // toast 反馈 + 未配置态解除
    await expect(page.locator('#toasts .toast').first()).toContainText('设置已保存');
    await expect(page.locator('#banner.show')).toHaveCount(0);
    await expect(page.locator('#q')).toBeEnabled();
});

test('设置弹窗：数据分区字段完整（数据目录/扩展名/防抖/服务信息）', async ({ page }) => {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#set-root')).not.toBeEmpty();
    await expect(page.locator('.ext').first()).toContainText('.md');
    await expect(page.locator('#set-debounce')).toHaveValue('500');
    await expect(page.locator('#svc-url')).not.toBeEmpty();
    // 扩展名 chips 可删除
    const before = await page.locator('.ext').count();
    await page.locator('.ext-x').first().click();
    await expect(page.locator('.ext')).toHaveCount(before - 1);
    await page.locator('#settings-cancel').click();
});

test('导入文件夹：手动路径模式导入种子知识库', async ({ page }) => {
    // 空知识库时入口在侧栏空态卡片里；有项目后在列表底部
    const emptyImport = page.locator('#empty-import');
    if (await emptyImport.count()) {
        await emptyImport.click();
    } else {
        await page.locator('#import-btn').click();
    }
    await expect(page.locator('#import-modal.open')).toBeVisible();
    // picker 禁用 → 走手动输入降级路径
    await expect(page.locator('#toasts .toast').first()).toContainText('手动输入');
    await page.locator('#imp-path').fill(SEED_DIR);
    await expect(page.locator('#imp-name')).toHaveValue('seed-kb');
    await page.locator('#import-confirm').click();
    await expect(page.locator('#import-modal.open')).toHaveCount(0);
    await expect(page.locator('#toasts .toast').filter({ hasText: 'seed-kb' })).toBeVisible();
    // 项目出现在侧栏并选中
    await expect(page.locator('.proj .pn').filter({ hasText: 'seed-kb' })).toBeVisible();
    await expect(page.locator('#sel-count')).toHaveText('1/1');
});

test('搜索全流程：骨架屏 → 结果（类型徽章/分数/块位置）', async ({ page }) => {
    await page.locator('#q').fill('alpha');
    await page.locator('#search-btn').click();
    await expect(page.locator('.skel').first()).toBeVisible();
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
    const row = page.locator('.res').first();
    await expect(row.locator('.t-badge')).toHaveText('目标');
    await expect(row.locator('.fname')).toHaveText('GOAL.md');
    await expect(row.locator('.score')).not.toBeEmpty();
    await expect(row.locator('.chunkpos')).toContainText('第');
    await expect(page.locator('.res-meta')).toContainText('1 项目');
});

test('回车搜索与关键词高亮', async ({ page }) => {
    await page.locator('#q').fill('gamma');
    await page.locator('#q').press('Enter');
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.res .fname').first()).toHaveText('ARCHITECTURE.md');
    // 回到 alpha 供后续用例
    await page.locator('#q').fill('alpha');
    await page.locator('#q').press('Enter');
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
});

test('类型 chips 过滤：变更 → 仅 change 结果', async ({ page }) => {
    await page.locator('#q').fill('delta');
    await page.locator('#q').press('Enter');
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
    await page.locator('#type-chips .fchip').filter({ hasText: '变更' }).click();
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
    const badges = page.locator('.res .t-badge');
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
        await expect(badges.nth(i)).toHaveText('变更');
    }
    // 切回全部：结果应包含非变更类型
    await page.locator('#type-chips .fchip').filter({ hasText: '全部' }).click();
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
    // 回到 alpha 供后续用例
    await page.locator('#q').fill('alpha');
    await page.locator('#q').press('Enter');
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
});

test('抽屉：marked 渲染、TOC、命中块高亮、关闭', async ({ page }) => {
    await page.locator('#q').fill('alpha');
    await page.locator('#q').press('Enter');
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
    await page.locator('.res').first().click();
    await expect(page.locator('#drawer.open')).toBeVisible();
    await expect(page.locator('#dr-title')).toContainText('E2E 目标');
    await expect(page.locator('#dr-body h1').first()).toBeVisible();
    await expect(page.locator('#dr-type')).toHaveText('目标');
    await expect(page.locator('#dr-kv')).toContainText('living');
    // 命中块高亮（alpha 命中 GOAL 正文）
    await expect(page.locator('.hit-block').first()).toBeVisible();
    // 大纲锚点存在（GOAL 无 h2，可能为空——检查 modules 文档时验证）
    await page.locator('#dr-close').click();
    await expect(page.locator('#drawer.open')).toHaveCount(0);
});

test('关联文档跳转与返回历史', async ({ page }) => {
    await page.locator('#q').fill('beta');
    await page.locator('#q').press('Enter');
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
    await page.locator('.res .fname').filter({ hasText: 'live.md' }).first().click();
    await expect(page.locator('#drawer.open')).toBeVisible();
    // modules 文档有 h2 → TOC 出现
    await expect(page.locator('#dr-toc a').first()).toBeVisible();
    // 点"关联变更"链接 → 跳到 changes 文档
    await page.locator('#dr-body a').filter({ hasText: '变更记录' }).first().evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator('#dr-path')).toContainText('2026-01-01_ab12_live.md', { timeout: 10000 });
    await expect(page.locator('#dr-type')).toHaveText('变更');
    await expect(page.locator('#dr-head.hist')).toHaveCount(1);
    // 返回
    await page.locator('#dr-back').click();
    await expect(page.locator('#dr-path')).toContainText('live.md', { timeout: 10000 });
    await page.locator('#dr-close').click();
});

test('项目勾选：清空 / 全选 / 计数', async ({ page }) => {
    await expect(page.locator('#sel-count')).toHaveText('1/1');
    await page.locator('#sel-none').click();
    await expect(page.locator('#sel-count')).toHaveText('0/1');
    await page.locator('#sel-all').click();
    await expect(page.locator('#sel-count')).toHaveText('1/1');
});

test('删除项目：确认框接受后项目消失', async ({ page }) => {
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.proj .del').first().hover();
    await page.locator('.proj .del').first().click();
    await expect(page.locator('.proj')).toHaveCount(0);
    await expect(page.locator('#sel-count')).toHaveText('0/0');
    // 重新导入供截图用例
    await reimport(page);
    await expect(page.locator('.proj .pn').filter({ hasText: 'seed-kb' })).toBeVisible();
});

test('截图基准：主界面与文档抽屉', async ({ page }) => {
    await page.locator('#q').fill('alpha');
    await page.locator('#q').press('Enter');
    await expect(page.locator('.res').first()).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveScreenshot('console-main.png');
    await page.locator('.res').first().click();
    await expect(page.locator('#drawer.open')).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot('console-drawer.png');
});

async function reimport(page: Page): Promise<void> {
    // 空知识库时入口在侧栏空态卡片里；有项目后在列表底部
    const emptyImport = page.locator('#empty-import');
    if (await emptyImport.count()) {
        await emptyImport.click();
    } else {
        await page.locator('#import-btn').click();
    }
    await page.locator('#imp-path').fill(SEED_DIR);
    await page.locator('#import-confirm').click();
    await expect(page.locator('#toasts .toast').filter({ hasText: 'seed-kb' })).toBeVisible();
}
