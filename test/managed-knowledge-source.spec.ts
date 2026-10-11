import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { HubManager } from '../src/server/manager';
import { createServer } from '../src/server/server';

describe('managed indexes exclude conversation evidence', () => {
    it('filters import, HTTP sync and rebuild, prunes old raw documents, and preserves standalone general indexing', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-knowledge-policy-'));
        const source = path.join(root, 'source');
        fs.mkdirSync(path.join(source, 'dev-conversations', 'commits'), { recursive: true });
        fs.mkdirSync(path.join(source, '_ai'), { recursive: true });
        const raw = path.join(source, 'dev-conversations', 'commits', 'raw.md');
        fs.writeFileSync(raw, '# raw-only-journal-marker\n\nUnverified conversation evidence.');
        fs.writeFileSync(path.join(source, '_ai', 'session.md'), '# raw-only-session-marker');
        fs.writeFileSync(path.join(source, 'README.md'), '# canonical-durable-fact\n\nOnly maintained knowledge.');
        fs.writeFileSync(path.join(source, 'note.txt'), 'generic-standalone-text');
        const inputs: string[] = [];
        const factory = () => ({ maxTokens: 500, async createEmbeddings(input: string | string[]) { const values = Array.isArray(input) ? input : [input]; inputs.push(...values); return { status: 'success' as const, output: values.map(() => [1, 0]) }; } });
        const manager = await HubManager.load({ managed: true, rootPath: path.join(root, 'indexes'), configPath: path.join(root, 'managed.json'), embeddingsFactory: factory });
        await manager.applyRuntimeSettings({ provider: 'minimax', apiKey: 'controlled-key', model: 'controlled' });
        const server = http.createServer(createServer(manager, { runtimeToken: 'source-policy-test' }));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        try {
            assert.equal((await manager.import(source, 'project-test')).filesTracked, 1);
            assert.ok(inputs.every(text => !text.includes('raw-only') && !text.includes('standalone-text')));
            // A stale index may contain evidence from a previous release.
            await manager.hub.upsertDocument({ project: 'project-test', uri: raw, text: 'stale-raw-body' });
            const synced = await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'project-test', sourceDir: source, extensions: ['.md', '.txt'] }) });
            assert.equal(synced.status, 200);
            assert.equal((await synced.json() as { filesTracked: number }).filesTracked, 1);
            const catalog = JSON.parse(fs.readFileSync(path.join(manager.hub.rootPath, 'project-test', 'catalog.json'), 'utf8'));
            assert.deepEqual(Object.keys(catalog.uriToId), [path.join(source, 'README.md')]);
            await manager.applyRuntimeSettings({ provider: 'minimax', apiKey: 'controlled-key', model: 'controlled' }, path.join(root, 'new-root'));
            const deadline = Date.now() + 5000;
            while (manager.rebuildStatus.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            assert.deepEqual(manager.rebuildStatus.errors, []); assert.equal(manager.rebuildStatus.running, false);
            const rebuilt = JSON.parse(fs.readFileSync(path.join(manager.hub.rootPath, 'project-test', 'catalog.json'), 'utf8'));
            assert.deepEqual(Object.keys(rebuilt.uriToId), [path.join(source, 'README.md')]);
            assert.ok(fs.readFileSync(raw, 'utf8').includes('raw-only-journal-marker'), 'evidence files must not be deleted');
            const configPath = path.join(root, 'standalone.json');
            fs.writeFileSync(configPath, JSON.stringify({ settings: { provider: 'minimax', apiKey: 'controlled-key', model: 'controlled', rootPath: path.join(root, 'standalone-indexes') } }));
            const standalone = await HubManager.load({ configPath, embeddingsFactory: factory });
            assert.equal((await standalone.import(source, 'generic')).filesTracked, 4, 'standalone remains a generic document index');
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    });
});
