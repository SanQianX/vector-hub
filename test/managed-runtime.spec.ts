import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { HubManager } from '../src/server/manager';
import { createServer } from '../src/server/server';

describe('shell-managed vector configuration', () => {
    it('migrates only legacy settings, keeps runtime keys in memory and revokes them on restart or clear', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-vector-'));
        const legacyPath = path.join(root, 'standalone.json');
        const legacy = { settings: { provider: 'openai', apiKey: 'legacy-vector-secret-marker', model: 'old-model' }, projects: { unrelated: { sourceDir: root } } };
        fs.writeFileSync(legacyPath, JSON.stringify(legacy));
        const options = { managed: true, rootPath: path.join(root, 'indexes'), configPath: path.join(root, 'managed.json'), legacyConfigPath: legacyPath,
            embeddingsFactory: () => ({ maxTokens: 500, model: 'controlled', async createEmbeddings(inputs: string | string[]) { return { status: 'success' as const, output: (Array.isArray(inputs) ? inputs : [inputs]).map(() => [1, 0]) }; } }) };
        const manager = await HubManager.load(options);
        assert.equal(manager.settings, undefined);
        assert.deepEqual(manager.registrations, {});
        assert.equal(manager.legacyEmbeddingSettings()?.apiKey, legacy.settings.apiKey);
        const server = http.createServer(createServer(manager, { runtimeToken: 'vector-runtime-test' }));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const call = (route: string, data: unknown, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
        const auth = { Authorization: 'Bearer vector-runtime-test' };
        try {
            assert.equal((await call('/api/internal/runtime-config', {})).status, 403);
            assert.equal((await call('/api/internal/runtime-config', {}, { ...auth, Origin: base })).status, 403);
            const exported = await call('/api/internal/embedding-config', {}, auth);
            assert.equal(exported.headers.get('Access-Control-Allow-Origin'), null);
            const old = await exported.json() as { migrationId: string; settings: { apiKey: string } };
            assert.equal(old.settings.apiKey, legacy.settings.apiKey);
            assert.equal((await call('/api/internal/retire-embedding', { migrationId: old.migrationId }, auth)).status, 200);
            assert.ok(fs.readFileSync(path.join(root, 'recovery', old.migrationId, 'vector-config.json'), 'utf8').includes('legacy-vector-secret-marker'));
            assert.deepEqual(JSON.parse(fs.readFileSync(legacyPath, 'utf8')), legacy);
            assert.ok(!fs.readFileSync(options.configPath, 'utf8').includes('secret-marker'));
            const settings = { provider: 'openai', apiKey: 'runtime-vector-secret-marker', model: 'new-model' };
            assert.equal((await call('/api/internal/runtime-config', { settings }, auth)).status, 200);
            assert.equal(manager.settings?.apiKey, settings.apiKey);
            assert.ok(!JSON.stringify(await (await fetch(base + '/api/settings')).json()).includes('secret-marker'));
            assert.ok(!fs.readFileSync(options.configPath, 'utf8').includes('secret-marker'));
            assert.equal((await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })).status, 409);
            assert.equal((await HubManager.load(options)).settings, undefined);
            await call('/api/internal/runtime-config', { settings: null }, auth);
            assert.equal(manager.settings, undefined);
            assert.equal(manager.hub.embeddings, undefined);
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    });
});
