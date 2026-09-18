import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDocumentIndex, VirtualFileStorage } from 'vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import {
    buildDocument,
    extractMetadata,
    inferDocType,
    parseFrontmatter,
    syncSourceFolder,
    KbFolderWatcher,
} from '../src/core/kb-sync';

class MockEmbeddings implements EmbeddingsModel {
    public readonly maxTokens = 500;
    public async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
        const texts = Array.isArray(inputs) ? inputs : [inputs];
        return { status: 'success', output: texts.map(() => [1, 0]) };
    }
}

function makeIndex(folder: string): LocalDocumentIndex {
    return new LocalDocumentIndex({
        folderPath: folder,
        embeddings: new MockEmbeddings(),
        storage: new VirtualFileStorage(),
    });
}

describe('kb-sync: inferDocType', () => {
    const root = 'D:\\kb\\demo';
    const t = (rel: string) => inferDocType(path.join(root, rel), root);

    it('classifies root documents', () => {
        assert.strictEqual(t('GOAL.md'), 'goal');
        assert.strictEqual(t('ARCHITECTURE.md'), 'architecture');
        assert.strictEqual(t('README.md'), 'readme');
        assert.strictEqual(t('notes.md'), 'doc');
    });

    it('classifies changes/ and modules/ including index files', () => {
        assert.strictEqual(t('changes\\00-index.md'), 'change-index');
        assert.strictEqual(t('changes\\2026-06-27_32ca2a1_live-counter.md'), 'change');
        assert.strictEqual(t('modules\\00-index.md'), 'module-index');
        assert.strictEqual(t('modules\\live-counter.md'), 'module');
    });

    it('falls back to doc for unknown trees', () => {
        assert.strictEqual(t('docs\\random.md'), 'doc');
        assert.strictEqual(t('a\\b\\deep.md'), 'doc');
    });
});

describe('kb-sync: parseFrontmatter', () => {
    it('parses scalars, inline arrays and block lists', () => {
        const text = [
            '---',
            'schema: minimal-kb/v1',
            'title: 实时 token 计数器',
            'tags: [sse, realtime]',
            'affectedModules:',
            '  - live-counter',
            '  - frontend-shell',
            'commit: 32ca2a1abc',
            '---',
            '# 正文标题',
            '',
            '内容。',
        ].join('\n');
        const parsed = parseFrontmatter(text);
        assert.strictEqual(parsed.meta.schema, 'minimal-kb/v1');
        assert.strictEqual(parsed.meta.title, '实时 token 计数器');
        assert.deepStrictEqual(parsed.meta.tags, ['sse', 'realtime']);
        assert.deepStrictEqual(parsed.meta.affectedModules, ['live-counter', 'frontend-shell']);
        assert.strictEqual(parsed.meta.commit, '32ca2a1abc');
        assert.strictEqual(parsed.body, '# 正文标题\n\n内容。');
    });

    it('handles CRLF line endings', () => {
        const text = '---\r\ntitle: T\r\n---\r\nbody';
        const parsed = parseFrontmatter(text);
        assert.strictEqual(parsed.meta.title, 'T');
        assert.strictEqual(parsed.body, 'body');
    });

    it('returns empty meta when no frontmatter or unterminated', () => {
        assert.deepStrictEqual(parseFrontmatter('# 直接正文').meta, {});
        assert.deepStrictEqual(parseFrontmatter('---\ntitle: 无闭合').meta, {});
        assert.strictEqual(parseFrontmatter('---\ntitle: 无闭合').body, '---\ntitle: 无闭合');
    });
});

describe('kb-sync: extractMetadata', () => {
    it('maps affectedModules to modules and joins arrays with commas', () => {
        const meta = extractMetadata('change', {
            affectedModules: ['cli-binary', 'product-branding'],
            tags: ['rename', 'cli'],
            commit: '236bd97',
            date: '2026-06-23',
            title: 'rename cli',
        });
        assert.strictEqual(meta.docType, 'change');
        assert.strictEqual(meta.modules, 'cli-binary, product-branding');
        assert.strictEqual(meta.tags, 'rename, cli');
        assert.strictEqual(meta.commit, '236bd97');
        assert.strictEqual(meta.date, '2026-06-23');
        // No undefined-valued keys are written.
        assert.strictEqual(meta.status, undefined);
        assert.strictEqual(meta.module, undefined);
    });
});

describe('kb-sync: syncSourceFolder', () => {
    let sourceDir: string;

    beforeEach(async () => {
        sourceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kb-sync-src-'));
        await fs.promises.mkdir(path.join(sourceDir, 'changes'));
        await fs.promises.mkdir(path.join(sourceDir, 'modules'));
        await fs.promises.writeFile(
            path.join(sourceDir, 'GOAL.md'),
            '---\ntitle: 目标\nstatus: living\ntags: [goal]\n---\n# 目标\n\n关于 token 用量的回顾系统。',
        );
        await fs.promises.writeFile(
            path.join(sourceDir, 'changes', '2026-06-27_live.md'),
            '---\ncommit: 32ca2a1\naffectedModules:\n  - live-counter\n---\n# 变更\n\n新增 SSE 端点。',
        );
        await fs.promises.writeFile(
            path.join(sourceDir, 'modules', 'live-counter.md'),
            '---\nmodule: live-counter\ntags: [sse]\n---\n# 模块\n\n实时计数器。',
        );
        await fs.promises.writeFile(path.join(sourceDir, 'modules', '.hidden.md'), '忽略隐藏文件');
    });

    afterEach(async () => {
        await fs.promises.rm(sourceDir, { recursive: true, force: true });
    });

    it('upserts documents with derived metadata on every chunk', async () => {
        const index = makeIndex('/kb-sync-index');
        await index.createIndex({ version: 1 });
        const result = await syncSourceFolder(index, sourceDir);
        assert.strictEqual(result.filesTracked, 3); // hidden file skipped
        assert.strictEqual(result.deleted, 0);

        const items = await index.listItems();
        assert.ok(items.length >= 3);
        const docTypes = new Set(items.map((item) => item.metadata.docType));
        assert.ok(docTypes.has('goal'));
        assert.ok(docTypes.has('change'));
        assert.ok(docTypes.has('module'));

        const changeChunk = items.find((item) => item.metadata.docType == 'change');
        assert.strictEqual(changeChunk?.metadata.modules, 'live-counter');
        assert.strictEqual(changeChunk?.metadata.commit, '32ca2a1');

        const goalChunk = items.find((item) => item.metadata.docType == 'goal');
        assert.strictEqual(goalChunk?.metadata.tags, 'goal');
        assert.strictEqual(goalChunk?.metadata.status, 'living');
    });

    it('stores the frontmatter-stripped body so chunk offsets align with the rendered body', async () => {
        const doc = buildDocument(
            path.join(sourceDir, 'GOAL.md'),
            sourceDir,
            await fs.promises.readFile(path.join(sourceDir, 'GOAL.md'), 'utf8'),
        );
        assert.ok(!doc.text.startsWith('---'));
        assert.ok(doc.text.startsWith('# 目标'));
    });

    it('deletes indexed documents whose files disappeared', async () => {
        const index = makeIndex('/kb-sync-index2');
        await index.createIndex({ version: 1 });
        await syncSourceFolder(index, sourceDir);

        await fs.promises.rm(path.join(sourceDir, 'modules', 'live-counter.md'));
        const result = await syncSourceFolder(index, sourceDir);
        assert.strictEqual(result.deleted, 1);
        assert.strictEqual(result.filesTracked, 2);

        const remaining = (await index.listDocuments()).map((d) => path.basename(d.uri));
        assert.ok(!remaining.includes('live-counter.md'));
    });

    it('respects the extension filter', async () => {
        await fs.promises.writeFile(path.join(sourceDir, 'photo.png'), 'binary');
        const index = makeIndex('/kb-sync-index3');
        await index.createIndex({ version: 1 });
        const result = await syncSourceFolder(index, sourceDir);
        assert.strictEqual(result.filesTracked, 3); // png not counted
    });
});

describe('kb-sync: KbFolderWatcher', () => {
    it('picks up new and deleted files after the debounce window', async () => {
        const sourceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kb-watch-'));
        const index = makeIndex('/kb-watch-index');
        await index.createIndex({ version: 1 });

        await fs.promises.writeFile(path.join(sourceDir, 'a.md'), '---\ntitle: A\n---\nalpha content');
        const watcher = new KbFolderWatcher(index, sourceDir, { debounceMs: 150 });
        await watcher.start();
        assert.strictEqual(watcher.trackedFileCount, 1);

        try {
            // New file appears → indexed after debounce.
            await fs.promises.writeFile(path.join(sourceDir, 'b.md'), '---\ntitle: B\n---\nbeta content');
            await new Promise((r) => setTimeout(r, 900));
            let docs = (await index.listDocuments()).map((d) => path.basename(d.uri)).sort();
            assert.deepStrictEqual(docs, ['a.md', 'b.md']);

            // File removed → document deleted after debounce.
            await fs.promises.rm(path.join(sourceDir, 'a.md'));
            await new Promise((r) => setTimeout(r, 900));
            docs = (await index.listDocuments()).map((d) => path.basename(d.uri));
            assert.deepStrictEqual(docs, ['b.md']);

            const items = await index.listItems();
            assert.ok(items.every((item) => typeof item.metadata.docType == 'string'));
        } finally {
            await watcher.stop();
            await fs.promises.rm(sourceDir, { recursive: true, force: true });
        }
    });
});
