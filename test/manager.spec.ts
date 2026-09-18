import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HubManager } from '../src/server/manager';
import type { HubSettings, EmbeddingsFactory } from '../src/server/manager';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';

/**
 * Deterministic mock embeddings — the factory returns a model whose name is
 * derived from the settings, so model-identity changes are observable in
 * rebuild behavior without any network calls.
 */
function mockFactory(): EmbeddingsFactory {
    return (settings: HubSettings): EmbeddingsModel => {
        const name = `${settings.provider}:${settings.model ?? 'default'}:${settings.endpoint ?? ''}`;
        return {
            maxTokens: 500,
            model: name,
            async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
                const texts = Array.isArray(inputs) ? inputs : [inputs];
                return { status: 'success', output: texts.map(() => [1, 0]) };
            },
        };
    };
}

describe('HubManager (global config + data root separation)', () => {
    let root: string;
    let root2: string;
    let configDir: string;
    let sourceDir: string;
    let configPath: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vector-hub-root-'));
        root2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vector-hub-root2-'));
        configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vector-hub-cfg-'));
        configPath = path.join(configDir, 'config.json');
        sourceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vector-hub-src-'));
        await fs.promises.writeFile(path.join(sourceDir, 'note-a.md'), '# 笔记 A\n\n关于猫的内容 cat animal');
        await fs.promises.writeFile(path.join(sourceDir, 'note-b.md'), '# 笔记 B\n\n关于 Python 的内容 code programming');
    });

    afterEach(async () => {
        for (const dir of [root, root2, configDir, sourceDir]) {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    async function makeManager(rootPath = root): Promise<HubManager> {
        return await HubManager.load({ rootPath, configPath, embeddingsFactory: mockFactory() });
    }

    it('starts unconfigured and persists settings in the global config (not the data dir)', async () => {
        const manager = await makeManager();
        assert.strictEqual(manager.settings?.apiKey, undefined);

        await manager.saveSettings({ provider: 'minimax', apiKey: 'sk-test-1234' });
        // Config lives outside the data directory:
        const saved = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
        assert.strictEqual(saved.settings.apiKey, 'sk-test-1234');
        assert.strictEqual(await fs.promises.access(path.join(root, 'hub.json')).then(() => true, () => false), false);
        // Effective root recorded:
        assert.strictEqual(manager.settings?.rootPath, path.resolve(root));

        // A fresh manager with the same config reads it back:
        const reloaded = await makeManager(root2);
        assert.strictEqual(reloaded.settings?.apiKey, 'sk-test-1234');
        assert.strictEqual(reloaded.hub.embeddingsModelName, 'minimax:default:');
    });

    it('migrates a legacy data-dir hub.json into the global config', async () => {
        await fs.promises.writeFile(
            path.join(root, 'hub.json'),
            JSON.stringify({ settings: { provider: 'minimax', apiKey: 'sk-legacy' }, projects: { old: { sourceDir, watch: false } } }),
        );
        const manager = await makeManager();
        assert.strictEqual(manager.settings?.apiKey, 'sk-legacy');
        assert.strictEqual(manager.registrations.old?.sourceDir, await fs.promises.realpath(sourceDir));
        const saved = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
        assert.strictEqual(saved.settings.apiKey, 'sk-legacy');
    });

    it('normalizes settings: empty model/endpoint stripped, extensions normalized, bad provider rejected', async () => {
        const manager = await makeManager();
        await manager.saveSettings({
            provider: 'minimax', apiKey: 'k', model: '  ', endpoint: ' ',
            extensions: ['md', '.TXT'], debounceMs: 250,
        });
        assert.strictEqual(manager.settings?.model, undefined);
        assert.strictEqual(manager.settings?.endpoint, undefined);
        assert.deepStrictEqual(manager.settings?.extensions, ['.md', '.txt']);
        assert.strictEqual(manager.debounceMs, 250);
        assert.deepStrictEqual(manager.extensions, ['.md', '.txt']);
        await assert.rejects(
            () => manager.saveSettings({ provider: 'azure' as never, apiKey: 'k' }),
            /Unknown provider/,
        );
    });

    it('imports a folder: registers mapping, syncs index, reports tracked files', async () => {
        const manager = await makeManager();
        await manager.saveSettings({ provider: 'minimax', apiKey: 'k' });

        const result = await manager.import(sourceDir);
        assert.strictEqual(result.project, path.basename(sourceDir));
        assert.strictEqual(result.filesTracked, 2);

        const registrations = manager.registrations;
        assert.strictEqual(registrations[result.project]?.sourceDir, await fs.promises.realpath(sourceDir));

        const projects = await manager.hub.listProjects();
        assert.strictEqual(projects.find((p) => p.name == result.project)?.docCount, 2);
    });

    it('rejects import of a non-directory path', async () => {
        const manager = await makeManager();
        await manager.saveSettings({ provider: 'minimax', apiKey: 'k' });
        const filePath = path.join(sourceDir, 'note-a.md');
        await assert.rejects(() => manager.import(filePath), /Not a folder/);
    });

    it('rebuilds indexed projects with a sourceDir after a model change and reports manual ones', async () => {
        const manager = await makeManager();
        await manager.saveSettings({ provider: 'minimax', apiKey: 'k' });

        // Imported project (rebuildable) + API-written project (manual).
        await manager.import(sourceDir);
        await manager.hub.upsertDocument({ project: 'api-project', uri: 'doc://x', text: 'api written' });

        // Same model identity — no rebuild.
        const none = await manager.saveSettings({ provider: 'minimax', apiKey: 'k2' });
        assert.strictEqual(none, undefined);

        // Model change — rebuild triggered and completes with fresh vectors.
        const triggered = await manager.saveSettings({ provider: 'minimax', apiKey: 'k', model: 'embo-v2' });
        assert.notStrictEqual(triggered, undefined);
        await waitFor(() => !manager.rebuildStatus.running);

        const status = manager.rebuildStatus;
        assert.strictEqual(status.done, status.total);
        assert.strictEqual(status.total, 1);
        assert.deepStrictEqual(status.manual, ['api-project']);
        assert.strictEqual(status.errors.length, 0);

        const projects = await manager.hub.listProjects();
        assert.strictEqual(projects.find((p) => p.name == path.basename(sourceDir))?.hasIndex, true);
        // API-written project is kept (its index may be the only copy) but
        // reported as manual — stale vectors, needs re-import by the caller.
        assert.strictEqual(projects.find((p) => p.name == 'api-project')?.hasIndex, true);
        assert.strictEqual(manager.hub.embeddingsModelName, 'minimax:embo-v2:');
    });

    it('hot-switches the data directory: new root active, old root untouched, registrations kept', async () => {
        const manager = await makeManager();
        await manager.saveSettings({ provider: 'minimax', apiKey: 'k' });
        const { project } = await manager.import(sourceDir);
        const oldRoot = manager.hub.rootPath;

        await manager.saveSettings({ provider: 'minimax', apiKey: 'k', rootPath: root2 });

        assert.strictEqual(manager.hub.rootPath, path.resolve(root2));
        assert.notStrictEqual(manager.hub.rootPath, oldRoot);
        // Registrations survive (config is global):
        assert.strictEqual(manager.registrations[project]?.sourceDir != undefined, true);
        // Old root still has the old index (untouched):
        assert.strictEqual(
            await fs.promises.access(path.join(root, project)).then(() => true, () => false),
            true,
        );
        // New root is empty until re-synced:
        const projects = await manager.hub.listProjects();
        assert.strictEqual(projects.length, 0);
        // Re-sync restores the project at the new root:
        await manager.hub.syncFolder(project, manager.registrations[project].sourceDir!);
        assert.strictEqual((await manager.hub.listProjects()).find((p) => p.name == project)?.docCount, 2);
    });

    it('deletes a project: index gone, registration removed, source untouched', async () => {
        const manager = await makeManager();
        await manager.saveSettings({ provider: 'minimax', apiKey: 'k' });
        const { project } = await manager.import(sourceDir);

        await manager.deleteProject(project);
        assert.strictEqual(manager.registrations[project], undefined);
        assert.strictEqual((await manager.hub.listProjects()).find((p) => p.name == project), undefined);
        // The source folder is never touched.
        await fs.promises.access(path.join(sourceDir, 'note-a.md'));
    });
});

function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            if (condition()) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                reject(new Error('waitFor timeout'));
            }
        }, 20);
    });
}
