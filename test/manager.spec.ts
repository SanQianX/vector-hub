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

describe('HubManager', () => {
    let root: string;
    let sourceDir: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vector-hub-root-'));
        sourceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vector-hub-src-'));
        await fs.promises.writeFile(path.join(sourceDir, 'note-a.md'), '# 笔记 A\n\n关于猫的内容 cat animal');
        await fs.promises.writeFile(path.join(sourceDir, 'note-b.md'), '# 笔记 B\n\n关于 Python 的内容 code programming');
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
        await fs.promises.rm(sourceDir, { recursive: true, force: true });
    });

    async function makeManager(): Promise<HubManager> {
        return await HubManager.load(root, { embeddingsFactory: mockFactory() });
    }

    it('starts unconfigured and saves settings persistently', async () => {
        const manager = await makeManager();
        assert.strictEqual(manager.settings, undefined);

        await manager.saveSettings({ provider: 'minimax', apiKey: 'sk-test-1234' });
        assert.strictEqual(manager.hub.embeddingsModelName, 'minimax:default:');

        // Persisted: a fresh manager over the same root reads it back.
        const reloaded = await makeManager();
        assert.strictEqual(reloaded.settings?.provider, 'minimax');
        assert.strictEqual(reloaded.settings?.apiKey, 'sk-test-1234');
        assert.strictEqual(reloaded.hub.embeddingsModelName, 'minimax:default:');
    });

    it('normalizes empty model/endpoint and rejects unknown providers', async () => {
        const manager = await makeManager();
        await manager.saveSettings({ provider: 'minimax', apiKey: 'k', model: '  ', endpoint: ' ' });
        assert.strictEqual(manager.settings?.model, undefined);
        assert.strictEqual(manager.settings?.endpoint, undefined);
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
