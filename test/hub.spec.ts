import assert from 'node:assert';
import path from 'node:path';
import { VectorHub } from '../src/core/hub';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import { VirtualFileStorage } from 'vectra';

/**
 * Deterministic bag-of-words embeddings: every word hashes to one of 64
 * dimensions and adds 1. Documents sharing words with the query score high
 * on cosine similarity, which makes ranking assertions predictable without
 * any network calls.
 */
class MockEmbeddings implements EmbeddingsModel {
    public readonly maxTokens = 500;

    public async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
        const texts = Array.isArray(inputs) ? inputs : [inputs];
        return {
            status: 'success',
            output: texts.map((text) => this.embed(text)),
        };
    }

    private embed(text: string): number[] {
        const vector = new Array<number>(64).fill(0);
        for (const word of text.toLowerCase().split(/\W+/)) {
            if (word.length == 0) {
                continue;
            }
            let hash = 0;
            for (const ch of word) {
                hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
            }
            vector[hash % 64] += 1;
        }
        return vector;
    }
}

describe('VectorHub', () => {
    let storage: VirtualFileStorage;

    function makeHub(): VectorHub {
        storage = new VirtualFileStorage();
        return new VectorHub({ rootPath: '/hub', embeddings: new MockEmbeddings(), storage });
    }

    beforeEach(() => {
        storage = new VirtualFileStorage();
    });

    it('lists no projects when the root is empty', async () => {
        const hub = makeHub();
        assert.deepStrictEqual(await hub.listProjects(), []);
    });

    it('rejects project names that could escape the root folder', () => {
        const hub = makeHub();
        assert.ok(!VectorHub.isValidProjectName('../evil'));
        assert.ok(!VectorHub.isValidProjectName('a/b'));
        assert.ok(!VectorHub.isValidProjectName('a\\b'));
        assert.ok(!VectorHub.isValidProjectName('.hidden'));
        assert.ok(VectorHub.isValidProjectName('tech-notes'));
        assert.throws(() => hub.getProjectIndex('../evil'), /Invalid project name/);
    });

    it('upserts documents and reports per-project stats', async () => {
        const hub = makeHub();
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat cat animal purr' });
        await hub.upsertDocument({ project: 'notes', uri: 'doc://b', text: 'dog dog animal bark' });
        await hub.upsertDocument({ project: 'wiki', uri: 'doc://c', text: 'python code programming' });

        const projects = await hub.listProjects();
        assert.deepStrictEqual(projects.map((p) => p.name), ['notes', 'wiki']);
        assert.ok(projects.every((p) => p.hasIndex));
        assert.strictEqual(projects[0].docCount, 2);
        assert.strictEqual(projects[1].docCount, 1);
        assert.ok(projects[0].chunkCount >= 2);
    });

    it('searches all indexed projects and ranks the matching document first', async () => {
        const hub = makeHub();
        await hub.upsertDocument({ project: 'notes', uri: 'doc://cat', text: 'cat cat animal purr' });
        await hub.upsertDocument({ project: 'notes', uri: 'doc://dog', text: 'dog dog animal bark' });
        await hub.upsertDocument({ project: 'wiki', uri: 'doc://py', text: 'python code programming' });

        const response = await hub.search('cat animal');
        assert.strictEqual(response.results.length > 0, true);
        assert.strictEqual(response.results[0].uri, 'doc://cat');
        assert.strictEqual(response.results[0].project, 'notes');
        assert.ok(response.results[0].score > 0);
        assert.ok(typeof response.tookMs == 'number');
        assert.deepStrictEqual(response.projectsSearched.sort(), ['notes', 'wiki']);
        assert.deepStrictEqual(response.projectsSkipped, []);
    });

    it('scopes search to selected projects', async () => {
        const hub = makeHub();
        await hub.upsertDocument({ project: 'notes', uri: 'doc://cat', text: 'cat cat animal purr' });
        await hub.upsertDocument({ project: 'wiki', uri: 'doc://py', text: 'python code programming' });

        const response = await hub.search('python', { projects: ['wiki'] });
        assert.deepStrictEqual(response.projectsSearched, ['wiki']);
        assert.ok(response.results.every((r) => r.project == 'wiki'));
    });

    it('applies minScore and maxResults', async () => {
        const hub = makeHub();
        await hub.upsertDocument({ project: 'notes', uri: 'doc://cat', text: 'cat cat animal purr' });
        await hub.upsertDocument({ project: 'notes', uri: 'doc://dog', text: 'dog dog animal bark' });
        await hub.upsertDocument({ project: 'wiki', uri: 'doc://py', text: 'python code programming' });

        // 'python code' is orthogonal to the animal docs → they score 0 and get filtered.
        const strict = await hub.search('python code', { minScore: 0.1 });
        assert.ok(strict.results.length <= 1);

        const limited = await hub.search('animal', { maxResults: 1 });
        assert.strictEqual(limited.results.length, 1);
    });

    it('skips projects without an index instead of failing the search', async () => {
        const hub = makeHub();
        await hub.upsertDocument({ project: 'notes', uri: 'doc://cat', text: 'cat cat animal purr' });
        await hub.upsertDocument({ project: 'wiki', uri: 'doc://py', text: 'python code programming' });

        // Simulate a project folder with no index in it (under the hub's
        // resolved root, since in-memory storage keys are path-sensitive).
        await storage.createFolder(path.join(hub.rootPath, 'empty-project'));

        const response = await hub.search('cat');
        assert.deepStrictEqual(response.projectsSkipped, ['empty-project']);
        assert.ok(response.projectsSearched.includes('notes'));
        assert.strictEqual(response.errors.length, 0);
    });

    it('deletes documents and reports when the project has no index', async () => {
        const hub = makeHub();
        await hub.upsertDocument({ project: 'notes', uri: 'doc://cat', text: 'cat cat animal purr' });
        assert.strictEqual(await hub.deleteDocument('notes', 'doc://cat'), true);
        assert.strictEqual(await hub.deleteDocument('missing', 'doc://x'), false);

        const projects = await hub.listProjects();
        assert.strictEqual(projects.find((p) => p.name == 'notes')?.docCount, 0);
    });
});
