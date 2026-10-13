import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { VirtualFileStorage } from '@sanqianx/vectra';
import { VectorHub } from '../src/core/hub';
import { createMockEmbeddings } from '../src/server/manager';

describe('verified chunk retrieval', () => {
    it('returns normalized source spans/hash and shares one query embedding across projects', async () => {
        const base = createMockEmbeddings();
        let queryCalls = 0;
        const model = { maxTokens: base.maxTokens, async createEmbeddings(input: string | string[]) {
            if (typeof input === 'string') queryCalls++;
            return base.createEmbeddings(input);
        } };
        const hub = new VectorHub({ rootPath: '/chunk-hub', storage: new VirtualFileStorage(), embeddings: model });
        const body = '# Recipe\r\n\r\nPlate export checks dirty state.\r\n';
        for (const project of ['recipe', 'review', 'other']) await hub.upsertDocument({ project, uri: `${project}.md`, text: body });
        const response = await hub.search('Plate export dirty', { resultLevel: 'chunk', perProjectLimit: 5, maxResults: 1 } as never);
        assert.equal(queryCalls, 1, 'a multi-project query must not pay for the same embedding repeatedly');
        assert.equal(response.resultLevel, 'chunk');
        assert.deepEqual([...new Set(response.results.map(r => r.project))].sort(), ['other', 'recipe', 'review']);
        for (const row of response.results) {
            assert.equal(row.scoreType, 'cosine');
            assert.equal(row.bodyHash, crypto.createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex'));
            assert.ok(Number.isInteger(row.startPos) && Number.isInteger(row.endPos));
            assert.ok(row.endPos! > row.startPos!);
            assert.equal(row.snippet, body.replace(/\r\n/g, '\n').slice(row.startPos, row.endPos).trim());
        }
    });
});
