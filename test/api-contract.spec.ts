import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server/server';
import { HubManager } from '../src/server/manager';
import type { EmbeddingsFactory, HubSettings } from '../src/server/manager';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';

/**
 * T2 API contract tests: every route, happy path and error path, against an
 * in-process server with mock embeddings (no network).
 */

function mockFactory(): EmbeddingsFactory {
    return (settings: HubSettings) => {
        const model: EmbeddingsModel & { model: string } = {
            maxTokens: 500,
            model: `mock:${settings.model ?? 'x'}`,
            async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
                const texts = Array.isArray(inputs) ? inputs : [inputs];
                return { status: 'success', output: texts.map(() => [1, 0]) };
            },
        };
        return model;
    };
}

describe('API contract (in-process server)', () => {
    let root: string;
    let configPath: string;
    let sourceDir: string;
    let outsideFile: string;
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'api-root-'));
        const configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'api-cfg-'));
        configPath = path.join(configDir, 'config.json');
        sourceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'api-src-'));
        outsideFile = path.join(configDir, 'secret.txt');
        await fs.promises.writeFile(outsideFile, 'SECRET');

        await fs.promises.writeFile(
            path.join(sourceDir, 'GOAL.md'),
            '---\ntitle: 目标\ntags: [goal]\n---\n# 目标\n\nalpha 目标文档内容。',
        );
        await fs.promises.writeFile(
            path.join(sourceDir, 'note.md'),
            '---\ntitle: 笔记\n---\n# 笔记\n\nbeta 笔记内容。',
        );

        const manager = await HubManager.load({ rootPath: root, configPath, embeddingsFactory: mockFactory() });
        await manager.saveSettings({ provider: 'minimax', apiKey: 'sk-contract-test' });
        await manager.import(sourceDir, 'kb', false);

        server = http.createServer(createServer(manager));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const dir of [root, path.dirname(configPath), sourceDir]) {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    });

    async function call(method: string, pathname: string, body?: unknown, headers?: Record<string, string>) {
        const res = await fetch(baseUrl + pathname, {
            method,
            headers: body != undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
            body: body != undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
        return { status: res.status, json, text, headers: res.headers };
    }

    it('serves the UI at GET /', async () => {
        const res = await call('GET', '/');
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type')?.includes('text/html'));
    });

    it('GET /api/health reports projects and embeddings model', async () => {
        const res = await call('GET', '/api/health');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.json.ok, true);
        assert.ok(Array.isArray(res.json.projects));
        assert.strictEqual(typeof res.json.embeddings.model, 'string');
    });

    it('GET /api/projects includes sourceDir and watching', async () => {
        const res = await call('GET', '/api/projects');
        assert.strictEqual(res.status, 200);
        const project = res.json.projects.find((p: any) => p.name == 'kb');
        assert.ok(project);
        assert.strictEqual(project.hasIndex, true);
        assert.strictEqual(project.docCount, 2);
        assert.ok(typeof project.sourceDir == 'string');
        assert.strictEqual(project.watching, false);
    });

    it('GET /api/search: 400 without q, 200 with metadata and docTypes filter', async () => {
        assert.strictEqual((await call('GET', '/api/search')).status, 400);

        const ok = await call('GET', '/api/search?q=' + encodeURIComponent('alpha') + '&projects=kb');
        assert.strictEqual(ok.status, 200);
        assert.ok(Array.isArray(ok.json.results));
        assert.ok(typeof ok.json.tookMs == 'number');
        assert.ok(Array.isArray(ok.json.projectsSearched));

        const filtered = await call('GET', '/api/search?q=' + encodeURIComponent('alpha') + '&docTypes=goal');
        assert.ok(filtered.json.results.every((r: any) => r.docType == 'goal'));
    });

    it('POST /api/documents + DELETE /api/documents lifecycle', async () => {
        assert.strictEqual((await call('POST', '/api/documents', { project: 'kb' })).status, 400);

        const created = await call('POST', '/api/documents', { project: 'kb', uri: 'doc://api-x', text: 'gamma api 写入' });
        assert.strictEqual(created.status, 200);
        assert.strictEqual(created.json.ok, true);

        const deleted = await call('DELETE', '/api/documents?project=kb&uri=' + encodeURIComponent('doc://api-x'));
        assert.strictEqual(deleted.status, 200);
        assert.strictEqual((await call('DELETE', '/api/documents?project=kb&uri=' + encodeURIComponent('doc://api-x'))).status, 404);
    });

    it('POST /api/sync and POST /api/import validate their bodies', async () => {
        assert.strictEqual((await call('POST', '/api/sync', {})).status, 400);
        assert.strictEqual((await call('POST', '/api/import', {})).status, 400);
        const bad = await call('POST', '/api/import', { sourceDir: path.join(root, 'nope') });
        assert.strictEqual(bad.status, 500);
    });

    it('GET/PUT /api/settings: masked key, validation, no-op save', async () => {
        const got = await call('GET', '/api/settings');
        assert.strictEqual(got.status, 200);
        assert.strictEqual(got.json.configured, true);
        assert.ok(got.json.settings.apiKey.startsWith('****'));
        assert.ok(typeof got.json.settings.rootPath == 'string');
        assert.ok(Array.isArray(got.json.settings.extensions));

        assert.strictEqual((await call('PUT', '/api/settings', { apiKey: 'k' })).status, 400);
        assert.strictEqual((await call('PUT', '/api/settings', { provider: 'minimax' })).status, 400);

        const same = await call('PUT', '/api/settings', {
            provider: 'minimax', apiKey: 'sk-contract-test',
            extensions: ['.md'], debounceMs: 250,
        });
        assert.strictEqual(same.status, 200);
        assert.strictEqual(same.json.rebuildTriggered, false);
    });

    it('GET /api/rebuild/status shape', async () => {
        const res = await call('GET', '/api/rebuild/status');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.json.running, false);
        assert.ok(Array.isArray(res.json.errors));
    });

    it('GET /api/document: source-first, metadata, 404s and the outside-sourceDir guard', async () => {
        assert.strictEqual((await call('GET', '/api/document')).status, 400);

        const uri = encodeURIComponent(path.join(sourceDir, 'GOAL.md'));
        const doc = await call('GET', '/api/document?project=kb&uri=' + uri);
        assert.strictEqual(doc.status, 200);
        assert.strictEqual(doc.json.sourceExists, true);
        assert.strictEqual(doc.json.docType, 'goal');
        assert.ok(String(doc.json.text).startsWith('# 目标'));

        assert.strictEqual(
            (await call('GET', '/api/document?project=kb&uri=' + encodeURIComponent('doc://missing'))).status,
            404,
        );
        // Arbitrary-file-read guard: uris outside the registered sourceDir are rejected.
        assert.strictEqual(
            (await call('GET', '/api/document?project=kb&uri=' + encodeURIComponent(outsideFile))).status,
            404,
        );
    });

    it('GET /api/system/pick-folder rejects non-loopback origins', async () => {
        const res = await call('GET', '/api/system/pick-folder', undefined, { Origin: 'https://evil.example.com' });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
    });

    it('DELETE /api/project removes the project', async () => {
        assert.strictEqual((await call('DELETE', '/api/project')).status, 400);
        const res = await call('DELETE', '/api/project?name=kb');
        assert.strictEqual(res.status, 200);
        const projects = await call('GET', '/api/projects');
        assert.strictEqual(projects.json.projects.find((p: any) => p.name == 'kb'), undefined);
    });

    it('unknown routes 404 with a JSON error', async () => {
        const res = await call('GET', '/api/nope');
        assert.strictEqual(res.status, 404);
        assert.ok(typeof res.json.error == 'string');
    });
});
