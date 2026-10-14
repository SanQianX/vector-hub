import assert from 'node:assert';
import { VectorHub } from '../src/core/hub';
import { VirtualFileStorage } from '@sanqianx/vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from '@sanqianx/vectra';

class StubEmbeddings implements EmbeddingsModel {
    public readonly maxTokens = 500;
    public queryCalls = 0;
    public documentCalls = 0;
    public constructor(private readonly respond: (text: string) => Promise<number[] | EmbeddingsResponse>) {}
    public async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
        const texts = Array.isArray(inputs) ? inputs : [inputs];
        if (typeof inputs === 'string') this.queryCalls += 1;
        else this.documentCalls += 1;
        const vectors: number[][] = [];
        for (const text of texts) {
            const outcome = await this.respond(text);
            if (!Array.isArray(outcome)) return outcome;
            vectors.push(outcome);
        }
        return { status: 'success', output: vectors };
    }
}

function vector(text: string): number[] {
    const values = new Array<number>(64).fill(0);
    let hash = 0;
    for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    values[hash % 64] = 1;
    return values;
}

async function withFakeClock<T>(run: (advance: (ms: number) => void) => Promise<T>): Promise<T> {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        return await run(ms => { now += ms; });
    } finally {
        Date.now = realNow;
    }
}

function makeHub(embeddings: EmbeddingsModel): VectorHub {
    return new VectorHub({ rootPath: '/hub', embeddings, storage: new VirtualFileStorage() });
}

class Deferred<T> {
    public resolve!: (value: T) => void;
    public reject!: (reason: unknown) => void;
    public readonly promise: Promise<T> = new Promise<T>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
    });
}

describe('VectorHub query embedding cache', () => {
    it('serves a query embedding from cache 31 seconds later (fake clock)', async () => {
        const embeddings = new StubEmbeddings(text => Promise.resolve(vector(text)));
        const hub = makeHub(embeddings);
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat animal' });
        await withFakeClock(async advance => {
            await hub.search('cat', { projects: ['notes'] });
            assert.strictEqual(embeddings.queryCalls, 1);
            advance(31000);
            await hub.search('cat', { projects: ['notes'] });
            assert.strictEqual(embeddings.queryCalls, 1, 'a 31-second-old query embedding must still be served from cache');
        });
    });

    it('still serves the cached query embedding at 599 seconds and expires after 10 minutes', async () => {
        const embeddings = new StubEmbeddings(text => Promise.resolve(vector(text)));
        const hub = makeHub(embeddings);
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat animal' });
        await withFakeClock(async advance => {
            await hub.search('cat', { projects: ['notes'] });
            advance(599000);
            await hub.search('cat', { projects: ['notes'] });
            assert.strictEqual(embeddings.queryCalls, 1, 'a 599-second-old query embedding must still be cached (10-minute TTL)');
            advance(2000);
            await hub.search('cat', { projects: ['notes'] });
            assert.strictEqual(embeddings.queryCalls, 2, 'the cache must expire after 10 minutes; it is not unbounded in time');
        });
    });

    it('keeps the query cache bounded: the oldest query is re-embedded after 100 newer distinct queries', async () => {
        const embeddings = new StubEmbeddings(text => Promise.resolve(vector(text)));
        const hub = makeHub(embeddings);
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat animal' });
        await hub.search('first query', { projects: ['notes'] });
        assert.strictEqual(embeddings.queryCalls, 1);
        for (let i = 0; i < 101; i += 1) await hub.search(`filler query ${i}`, { projects: ['notes'] });
        await hub.search('first query', { projects: ['notes'] });
        assert.strictEqual(embeddings.queryCalls, 103, 'the first query must have been evicted by the bounded cache');
    });

    it('an in-flight response from a replaced embeddings model never fills the new cache', async () => {
        let release: ((value: number[]) => void) | undefined;
        const oldModel = new StubEmbeddings(text => text === 'cat'
            ? new Promise<number[]>(resolve => { release = resolve; })
            : Promise.resolve(vector(text)));
        const newModel = new StubEmbeddings(text => Promise.resolve(vector(text)));
        const hub = makeHub(oldModel);
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat animal' });
        const pending = hub.search('cat', { projects: ['notes'] });
        await new Promise(resolve => setImmediate(resolve));
        hub.setEmbeddings(newModel);
        release!(vector('old model'));
        await pending;
        assert.strictEqual(oldModel.queryCalls, 1);
        assert.strictEqual(newModel.queryCalls, 0);
        await hub.search('cat', { projects: ['notes'] });
        assert.strictEqual(newModel.queryCalls, 1, 'the swapped-in model must answer; the old in-flight result must be neither served nor cached');
    });

    it('a failed query embedding is not cached and succeeds on retry', async () => {
        let failQueries = true;
        const embeddings = new StubEmbeddings(text => text === 'cat' && failQueries
            ? Promise.reject(new Error('embed down'))
            : Promise.resolve(vector(text)));
        const hub = makeHub(embeddings);
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat animal' });
        const failed = await hub.search('cat', { projects: ['notes'] });
        assert.ok(failed.errors.length >= 1, 'the embedding failure surfaces as a per-project error');
        failQueries = false;
        await hub.search('cat', { projects: ['notes'] });
        assert.strictEqual(embeddings.queryCalls, 2, 'the failure must not be cached');
        await hub.search('cat', { projects: ['notes'] });
        assert.strictEqual(embeddings.queryCalls, 2, 'the successful retry is cached');
    });

    it('a rejected in-flight old-model query never deletes the new model cache entry', async () => {
        const gate = new Deferred<number[]>();
        const oldModel = new StubEmbeddings(text => text === 'cat' ? gate.promise : Promise.resolve(vector(text)));
        const newModel = new StubEmbeddings(text => Promise.resolve(vector(text)));
        const hub = makeHub(oldModel);
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat animal' });
        const pending = hub.search('cat', { projects: ['notes'] });
        await new Promise(resolve => setImmediate(resolve));
        hub.setEmbeddings(newModel);
        await hub.search('cat', { projects: ['notes'] });
        assert.strictEqual(newModel.queryCalls, 1);
        gate.reject(new Error('old model died'));
        await pending.catch(() => undefined);
        await new Promise(resolve => setImmediate(resolve));
        await hub.search('cat', { projects: ['notes'] });
        assert.strictEqual(newModel.queryCalls, 1, 'a late old-model rejection must not delete the new model cache entry');
    });

    it('a non-success in-flight old-model response never deletes the new model cache entry', async () => {
        const gate = new Deferred<void>();
        const oldModel = new StubEmbeddings(text => text === 'cat'
            ? gate.promise.then(() => ({ status: 'error', message: 'provider down' } as EmbeddingsResponse))
            : Promise.resolve(vector(text)));
        const newModel = new StubEmbeddings(text => Promise.resolve(vector(text)));
        const hub = makeHub(oldModel);
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat animal' });
        const pending = hub.search('cat', { projects: ['notes'] });
        await new Promise(resolve => setImmediate(resolve));
        hub.setEmbeddings(newModel);
        await hub.search('cat', { projects: ['notes'] });
        assert.strictEqual(newModel.queryCalls, 1);
        gate.resolve();
        await pending;
        await new Promise(resolve => setImmediate(resolve));
        await hub.search('cat', { projects: ['notes'] });
        assert.strictEqual(newModel.queryCalls, 1, 'a late old-model non-success response must not delete the new model cache entry');
    });

    it('a stale failed query never deletes the replacement entry created after TTL expiry', async () => {
        const gate = new Deferred<number[]>();
        let first = true;
        const embeddings = new StubEmbeddings(text => {
            if (text === 'cat' && first) { first = false; return gate.promise; }
            return Promise.resolve(vector(text));
        });
        const hub = makeHub(embeddings);
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat animal' });
        await withFakeClock(async advance => {
            const stale = hub.search('cat', { projects: ['notes'] });
            await new Promise(resolve => setImmediate(resolve));
            advance(601000);
            await hub.search('cat', { projects: ['notes'] });
            assert.strictEqual(embeddings.queryCalls, 2, 'the expired entry is replaced by a fresh embedding');
            gate.reject(new Error('stale query failed late'));
            await stale.catch(() => undefined);
            await new Promise(resolve => setImmediate(resolve));
            await hub.search('cat', { projects: ['notes'] });
            assert.strictEqual(embeddings.queryCalls, 2, 'a late stale rejection must not delete the replacement entry');
        });
    });

    it('a stale failed query never deletes the replacement entry created after LRU eviction', async () => {
        const gate = new Deferred<number[]>();
        let first = true;
        const embeddings = new StubEmbeddings(text => {
            if (text === 'cat' && first) { first = false; return gate.promise; }
            return Promise.resolve(vector(text));
        });
        const hub = makeHub(embeddings);
        await hub.upsertDocument({ project: 'notes', uri: 'doc://a', text: 'cat animal' });
        const stale = hub.search('cat', { projects: ['notes'] });
        await new Promise(resolve => setImmediate(resolve));
        for (let i = 0; i < 101; i += 1) await hub.search(`filler query ${i}`, { projects: ['notes'] });
        await hub.search('cat', { projects: ['notes'] });
        assert.strictEqual(embeddings.queryCalls, 103, 'the evicted entry is replaced by a fresh embedding');
        gate.reject(new Error('stale query failed late'));
        await stale.catch(() => undefined);
        await new Promise(resolve => setImmediate(resolve));
        await hub.search('cat', { projects: ['notes'] });
        assert.strictEqual(embeddings.queryCalls, 103, 'a late stale rejection must not delete the replacement entry');
    });
});
