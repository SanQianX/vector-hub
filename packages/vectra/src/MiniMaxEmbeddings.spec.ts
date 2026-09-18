import assert from 'node:assert';
import sinon from 'sinon';
import { MiniMaxEmbeddings, MiniMaxEmbeddingsOptions } from './MiniMaxEmbeddings';

describe('MiniMaxEmbeddings', () => {
  let sandbox: sinon.SinonSandbox;
  let fetchStub: sinon.SinonStub;

  function makeFetchResponse(status: number, data: any, statusText = ''): Response {
    return {
      status,
      statusText,
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      json: async () => data,
      text: async () => JSON.stringify(data),
    } as Response;
  }

  const successData = {
    vectors: [[0.1, 0.2], [0.3, 0.4]],
    total_tokens: 64,
    base_resp: { status_code: 0, status_msg: '' },
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    fetchStub = sandbox.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('applies defaults and trims trailing slash from endpoint', () => {
    const inst = new MiniMaxEmbeddings({ apiKey: 'key', endpoint: 'https://api.minimax.cn/' });

    assert.strictEqual(inst.options.endpoint, 'https://api.minimax.cn');
    assert.strictEqual(inst.options.model, 'embo-01');
    assert.strictEqual(inst.model, 'embo-01');
    assert.strictEqual(inst.maxTokens, 500);
    assert.deepStrictEqual(inst.options.retryPolicy, [2000, 5000]);
  });

  it('respects overrides for model and maxTokens', () => {
    const inst = new MiniMaxEmbeddings({
      apiKey: 'key',
      endpoint: 'https://api.minimaxi.com',
      model: 'custom-model',
      maxTokens: 1234,
    } as MiniMaxEmbeddingsOptions);

    assert.strictEqual(inst.options.endpoint, 'https://api.minimaxi.com');
    assert.strictEqual(inst.model, 'custom-model');
    assert.strictEqual(inst.maxTokens, 1234);
  });

  it('sends query type for string input and returns vectors', async () => {
    fetchStub.resolves(makeFetchResponse(200, {
      vectors: [[0.1, 0.2]],
      total_tokens: 8,
      base_resp: { status_code: 0, status_msg: '' },
    }));

    const inst = new MiniMaxEmbeddings({ apiKey: 'sk-test' });
    const result = await inst.createEmbeddings('什么是向量数据库？');

    assert.strictEqual(fetchStub.callCount, 1);
    const [url, init] = fetchStub.firstCall.args;
    assert.strictEqual(url, 'https://api.minimax.cn/v1/embeddings');
    assert.strictEqual((init.headers as Headers).get('Authorization'), 'Bearer sk-test');
    assert.deepStrictEqual(JSON.parse(init.body), {
      model: 'embo-01',
      texts: ['什么是向量数据库？'],
      type: 'query',
    });
    assert.strictEqual(result.status, 'success');
    assert.deepStrictEqual(result.output, [[0.1, 0.2]]);
    assert.strictEqual(result.model, 'embo-01');
    assert.deepStrictEqual(result.usage, { total_tokens: 8 });
  });

  it('sends db type for array input', async () => {
    fetchStub.resolves(makeFetchResponse(200, successData));

    const inst = new MiniMaxEmbeddings({ apiKey: 'sk-test' });
    const result = await inst.createEmbeddings(['chunk one', 'chunk two']);

    const [, init] = fetchStub.firstCall.args;
    assert.deepStrictEqual(JSON.parse(init.body), {
      model: 'embo-01',
      texts: ['chunk one', 'chunk two'],
      type: 'db',
    });
    assert.strictEqual(result.status, 'success');
    assert.deepStrictEqual(result.output, [[0.1, 0.2], [0.3, 0.4]]);
  });

  it('reports API errors that arrive with an HTTP 200 status', async () => {
    fetchStub.resolves(makeFetchResponse(200, {
      base_resp: { status_code: 2013, status_msg: 'invalid params' },
    }));

    const inst = new MiniMaxEmbeddings({ apiKey: 'sk-test' });
    const result = await inst.createEmbeddings('hello');

    assert.strictEqual(result.status, 'error');
    assert.ok((result.message || '').includes('2013'));
    assert.ok((result.message || '').includes('invalid params'));
  });

  it('reports HTTP errors without base_resp using the response status', async () => {
    fetchStub.resolves(makeFetchResponse(503, {} as any, 'Service Unavailable'));

    const inst = new MiniMaxEmbeddings({ apiKey: 'sk-test' });
    const result = await inst.createEmbeddings('hello');

    assert.strictEqual(result.status, 'error');
    assert.ok((result.message || '').includes('503'));
  });

  it('429 retry path obeys retryPolicy delays and eventually succeeds', async () => {
    const clock = sandbox.useFakeTimers();

    const resp429 = makeFetchResponse(429, {} as any);
    const resp200 = makeFetchResponse(200, {
      vectors: [[0.1]],
      base_resp: { status_code: 0, status_msg: '' },
    });

    fetchStub.onCall(0).resolves(resp429);
    fetchStub.onCall(1).resolves(resp429);
    fetchStub.onCall(2).resolves(resp200);

    const inst = new MiniMaxEmbeddings({ apiKey: 'sk-test', retryPolicy: [10, 20] });

    const p = inst.createEmbeddings('x');
    await clock.tickAsync(10);
    await clock.tickAsync(20);
    const result = await p;

    assert.strictEqual(fetchStub.callCount, 3);
    assert.strictEqual(result.status, 'success');

    clock.restore();
  });

  it('429 with empty retryPolicy returns rate_limited', async () => {
    fetchStub.resolves(makeFetchResponse(429, {} as any));

    const inst = new MiniMaxEmbeddings({ apiKey: 'sk-test', retryPolicy: [] });
    const result = await inst.createEmbeddings('x');

    assert.strictEqual(result.status, 'rate_limited');
    assert.ok((result.message || '').includes('rate limit'));
  });
});
