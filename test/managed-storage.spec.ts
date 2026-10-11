import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { HubManager } from '../src/server/manager';
import { createServer } from '../src/server/server';

describe('managed storage follows the knowledge root', () => {
    it('switches and rebuilds without touching old indexes, leaking credentials or routing queued writes to the old hub', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-managed-storage-'));
        const oldRoot = path.join(root, 'old'), nextRoot = path.join(root, 'knowledge', '.indexes');
        const source = path.join(root, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'fact.md'), '# Durable fact\n\nold fact');
        const configPath = path.join(root, 'config.json');
        let embeddingCalls = 0;
        const factory = () => ({ maxTokens: 500, async createEmbeddings(inputs: string | string[]) { embeddingCalls++; return { status: 'success' as const, output: (Array.isArray(inputs) ? inputs : [inputs]).map(() => [1, 0]) }; } });
        const manager = await HubManager.load({ managed: true, rootPath: oldRoot, configPath, embeddingsFactory: factory });
        const server = http.createServer(createServer(manager, { runtimeToken: 'storage-runtime-test' }));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const settings = { provider: 'minimax', apiKey: 'runtime-credential-marker', model: 'controlled' };
        const call = (route: string, body: unknown, auth = false) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer storage-runtime-test' } : {}) }, body: JSON.stringify(body) });
        const wait = async () => { const end = Date.now() + 5000; while (manager.rebuildStatus.running && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(manager.rebuildStatus.running, false); assert.deepEqual(manager.rebuildStatus.errors, []); };
        try {
            await call('/api/internal/runtime-config', { settings }, true);
            await manager.import(source, 'project-test');
            const oldIndex = path.join(oldRoot, 'project-test', 'index.json'), bytes = fs.readFileSync(oldIndex);
            let release!: () => void;
            const held = manager.withProjectWrite('project-test', () => new Promise<void>(resolve => { release = resolve; }));
            while (!release) await new Promise(resolve => setImmediate(resolve));
            let switching = false;
            const apply = manager.applyRuntimeSettings.bind(manager);
            manager.applyRuntimeSettings = (input, storageRoot) => { switching = true; return apply(input, storageRoot); };
            const switchRequest = call('/api/internal/runtime-config', { settings, storageRoot: nextRoot }, true);
            const deadline = Date.now() + 5000;
            while (!switching && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
            assert.equal(switching, true);
            const queued = call('/api/documents', { project: 'project-test', uri: 'late-document', text: 'new root only', docType: 'note' });
            release(); await held;
            assert.equal((await switchRequest).status, 200);
            assert.equal(manager.hub.rootPath, nextRoot);
            assert.equal((await queued).status, 200);
            await wait();
            assert.deepEqual(fs.readFileSync(oldIndex), bytes);
            const current = await manager.hub.listProjects(); assert.ok(current.find(p => p.name === 'project-test')!.chunkCount > 0);
            assert.equal(manager.hub.embeddings != undefined, true);
            assert.ok(!fs.readFileSync(configPath, 'utf8').includes('runtime-credential-marker'));
            const badRoot = path.join(root, 'occupied'); fs.writeFileSync(badRoot, 'not a directory');
            assert.equal((await call('/api/internal/runtime-config', { settings, storageRoot: badRoot }, true)).status, 409);
            assert.equal(manager.hub.rootPath, nextRoot);
            assert.equal((await call('/api/internal/runtime-config', { settings, storageRoot: 'relative-root' }, true)).status, 409);
            const linkedRoot = path.join(root, 'linked-indexes'); fs.symlinkSync(nextRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
            assert.equal((await call('/api/internal/runtime-config', { settings, storageRoot: linkedRoot }, true)).status, 409);
            await assert.rejects(HubManager.load({ managed: true, rootPath: linkedRoot, configPath }), /real directory/);
            const restarted = await HubManager.load({ managed: true, configPath, embeddingsFactory: factory });
            assert.equal(restarted.hub.rootPath, nextRoot);
            assert.equal(restarted.settings, undefined);
            assert.ok((await restarted.hub.listProjects()).some(p => p.name === 'project-test' && p.chunkCount > 0));
            const priorCalls = embeddingCalls;
            await restarted.applyRuntimeSettings(settings as any, nextRoot);
            assert.equal(restarted.rebuildStatus.running, false, 'normal restart must not start a full paid rebuild');
            assert.equal(embeddingCalls, priorCalls);
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
    });

    it('does not report a rebuild complete before its restart identity is persisted, and can retry a failed save', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-rebuild-state-'));
        const source = path.join(root, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'fact.md'), 'durable fact');
        const manager = await HubManager.load({ managed: true, rootPath: path.join(root, 'old'), configPath: path.join(root, 'config.json'), embeddingsFactory: () => ({ maxTokens: 500, async createEmbeddings(inputs: string | string[]) { return { status: 'success' as const, output: (Array.isArray(inputs) ? inputs : [inputs]).map(() => [1, 0]) }; } }) });
        const settings = { provider: 'minimax' as const, apiKey: 'runtime-only', model: 'controlled' };
        try {
            await manager.applyRuntimeSettings(settings);
            await manager.import(source, 'test-project');
            const internal = manager as any, original = internal._saveConfig.bind(manager);
            let release!: () => void, fail = true;
            internal._saveConfig = async () => {
                if (manager.rebuildStatus.running) {
                    await new Promise<void>(resolve => { release = resolve; });
                    if (fail) throw new Error('controlled state write failure');
                }
                return original();
            };
            await manager.applyRuntimeSettings(settings, path.join(root, 'knowledge', '.indexes'));
            const deadline = Date.now() + 5000;
            while (!release && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
            assert.ok(release); assert.equal(manager.rebuildStatus.running, true);
            release();
            while (manager.rebuildStatus.running && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
            assert.match(manager.rebuildStatus.errors[0].message, /state write failure/);
            fail = false; release = undefined as any;
            await manager.applyRuntimeSettings(settings, path.join(root, 'knowledge', '.indexes'));
            while (!release && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
            assert.ok(release); release();
            while (manager.rebuildStatus.running && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
            assert.equal(manager.rebuildStatus.running, false); assert.deepEqual(manager.rebuildStatus.errors, []);
            assert.match(JSON.parse(fs.readFileSync(manager.configPath, 'utf8')).indexIdentity, /^[a-f0-9]{64}$/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
});
