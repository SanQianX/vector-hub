import path from 'node:path';
import crypto from 'node:crypto';
import { LocalDocumentIndex, LocalFileStorage } from '@sanqianx/vectra';
import type { EmbeddingsModel, EmbeddingsResponse, FileStorage, LocalDocumentResult } from '@sanqianx/vectra';
import { KbFolderWatcher, syncSourceFolder } from './kb-sync';
import type {
    ProjectInfo,
    SearchOptions,
    SearchResponse,
    SearchResultItem,
    SyncOptions,
    UpsertDocumentOptions,
    VectorHubOptions,
} from './types';

/**
 * Multi-project vector retrieval hub built on Vectra.
 *
 * @remarks
 * The hub root folder holds one sub-folder per project; each sub-folder is a
 * self-contained `LocalDocumentIndex` (vectors + full text + catalog). The
 * hub layers project enumeration, isolated multi-project search (results
 * merged by score), and folder sync on top.
 *
 * This class is pure library code — no HTTP, no DOM — so it can be imported
 * into any Node process. The HTTP layer (`createServer`) and the visual
 * console (`ui/index.html`) are thin, optional attachments on top of it.
 *
 * ```ts
 * const hub = new VectorHub({
 *   rootPath: './data',
 *   embeddings: createMiniMaxEmbeddings(process.env.MINIMAX_API_KEY!),
 * });
 * const { results } = await hub.search('怎么接入向量检索', { maxResults: 5 });
 * ```
 */
export class VectorHub {
    private readonly _rootPath: string;
    private _embeddings: EmbeddingsModel | undefined;
    private readonly _storage: FileStorage;
    private readonly _indexes = new Map<string, LocalDocumentIndex>();
    private readonly _queryCache = new Map<string, { until: number; value: Promise<EmbeddingsResponse> }>();
    private _queryDimensions = 0;
    /** Projects whose BM25 build failed once (e.g. vectra's "Invalid string
     * length" on large corpora) — skip straight to semantic for them. */
    private readonly _bm25Broken = new Set<string>();

    public constructor(options: VectorHubOptions) {
        this._rootPath = path.resolve(options.rootPath);
        this._embeddings = options.embeddings;
        this._storage = options.storage ?? new LocalFileStorage();
    }

    /**
     * Swaps the embeddings model at runtime and drops all cached project
     * indexes so new indexes pick up the new model.
     *
     * @remarks
     * Vectors from different models live in incompatible spaces. After
     * switching, existing indexes hold stale vectors and must be rebuilt
     * (delete + re-sync) — see the server layer's rebuild flow.
     */
    public setEmbeddings(model: EmbeddingsModel | undefined): void {
        this._embeddings = model;
        this._indexes.clear();
        this._queryCache.clear();
        this._queryDimensions = 0;
    }

    /** Absolute path of the hub root folder. */
    public get rootPath(): string {
        return this._rootPath;
    }

    /** The embeddings model every project index uses, when configured. */
    public get embeddings(): EmbeddingsModel | undefined {
        return this._embeddings;
    }

    /** Human-readable name of the embeddings model, when available. */
    public get embeddingsModelName(): string | undefined {
        const model = (this._embeddings as { model?: unknown } | undefined)?.model;
        return typeof model == 'string' ? model : undefined;
    }

    /**
     * Validates a project name. Project names become folder names inside the
     * hub root, so path separators and traversal fragments are rejected.
     */
    public static isValidProjectName(name: string): boolean {
        return (
            name.length > 0 &&
            !name.includes('/') &&
            !name.includes('\\') &&
            name !== '.' &&
            name !== '..' &&
            !name.startsWith('.')
        );
    }

    /**
     * Returns (and caches) the document index for a project, creating the
     * wrapper lazily. Does not create the index on disk.
     * @param project Project (sub-folder) name.
     */
    public getProjectIndex(project: string): LocalDocumentIndex {
        if (!VectorHub.isValidProjectName(project)) {
            throw new Error(`Invalid project name: '${project}'`);
        }
        let index = this._indexes.get(project);
        if (index == undefined) {
            const model = this._embeddings;
            const sharedQueries: EmbeddingsModel | undefined = model ? {
                maxTokens: model.maxTokens,
                createEmbeddings: inputs => typeof inputs === 'string' ? this._queryEmbedding(model, inputs) : model.createEmbeddings(inputs),
            } : undefined;
            index = new LocalDocumentIndex({
                folderPath: path.join(this._rootPath, project),
                embeddings: sharedQueries,
                storage: this._storage,
            });
            this._indexes.set(project, index);
        }
        return index;
    }

    private _queryEmbedding(model: EmbeddingsModel, text: string): Promise<EmbeddingsResponse> {
        if (model !== this._embeddings) return model.createEmbeddings(text);
        const key = crypto.createHash('sha256').update(text).digest('hex');
        const previous = this._queryCache.get(key);
        if (previous && previous.until > Date.now()) return previous.value;
        const value = model.createEmbeddings(text).then(result => {
            if (result.status !== 'success') this._queryCache.delete(key);
            else if (model === this._embeddings) this._queryDimensions = result.output?.[0]?.length || 0;
            return result;
        }, error => { this._queryCache.delete(key); throw error; });
        this._queryCache.set(key, { until: Date.now() + 30000, value });
        while (this._queryCache.size > 100) this._queryCache.delete(this._queryCache.keys().next().value!);
        return value;
    }

    /**
     * Lists the projects (sub-folders) in the hub root with index stats.
     */
    public async listProjects(): Promise<ProjectInfo[]> {
        // Note: no pathExists pre-check — in-memory storages only track
        // folders they were told about, so the root itself may have no entry
        // while its children exist. A failing listFiles means "no root".
        let entries: { name: string; isFolder: boolean }[];
        try {
            entries = await this._storage.listFiles(this._rootPath);
        } catch {
            return [];
        }

        const names = entries
            .filter((entry) => entry.isFolder && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort();

        return await Promise.all(
            names.map(async (name) => {
                const index = this.getProjectIndex(name);
                const hasIndex = await index.isIndexCreated().catch(() => false);
                let docCount = 0;
                let chunkCount = 0;
                if (hasIndex) {
                    try {
                        const stats = await index.getCatalogStats();
                        docCount = stats.documents;
                        chunkCount = stats.chunks;
                    } catch {
                        // Index exists but cannot be read — report zeros.
                    }
                }
                return { name, hasIndex, docCount, chunkCount };
            }),
        );
    }

    /**
     * Upserts a document into a project index, creating the index when the
     * project is indexed for the first time. Re-upserting unchanged content
     * is a no-op (Vectra's hash-based skip).
     */
    public async upsertDocument(options: UpsertDocumentOptions): Promise<void> {
        this._requireEmbeddings();
        const index = this.getProjectIndex(options.project);
        await this._ensureProjectFolder(options.project);
        if (!(await index.isIndexCreated())) {
            await index.createIndex({ version: 1 });
        }
        await index.upsertDocument(options.uri, options.text, options.docType, options.metadata);
    }

    /**
     * Deletes a document from a project index.
     * @returns Whether the document existed and was deleted.
     */
    public async deleteDocument(project: string, uri: string): Promise<boolean> {
        const index = this.getProjectIndex(project);
        if (!(await index.isIndexCreated().catch(() => false))) {
            return false;
        }
        // Vectra's deleteDocument is a no-op for unknown uris; check first so
        // callers can distinguish "deleted" from "was not there".
        const documentId = await index.getDocumentId(uri).catch(() => undefined);
        if (!documentId) {
            return false;
        }
        await index.deleteDocument(uri);
        return true;
    }

    /**
     * Searches the selected projects (default: every project with an index)
     * in parallel and merges the results by score.
     *
     * @remarks
     * Projects without an index are skipped and reported in
     * `projectsSkipped`; a project whose query fails is reported in `errors`
     * without failing the whole search.
     */
    public async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
        this._requireEmbeddings();
        const start = Date.now();
        // Strip undefined keys before merging — callers (e.g. the REST layer)
        // commonly pass `{ minScore: undefined }` for absent query params, and
        // Object.assign would overwrite the defaults with undefined.
        const provided = Object.fromEntries(
            Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
        );
        const opts = Object.assign(
            { maxResults: 10, maxDocuments: 5, maxChunks: 20, minScore: 0, snippetTokens: 120 },
            provided,
        );

        const requested = opts.projects ?? (await this.listProjects()).map((project) => project.name);

        const candidates: { name: string; index: LocalDocumentIndex }[] = [];
        const projectsSkipped: string[] = [];
        for (const name of requested) {
            if (!VectorHub.isValidProjectName(name)) {
                continue;
            }
            const index = this.getProjectIndex(name);
            if (await index.isIndexCreated().catch(() => false)) {
                candidates.push({ name, index });
            } else {
                projectsSkipped.push(name);
            }
        }

        const settled = await Promise.allSettled(
            candidates.map(({ name, index }) => {
                const useBm25 = opts.resultLevel !== 'chunk' && opts.isBm25 && !this._bm25Broken.has(name);
                return index
                    .queryDocuments(query, {
                        maxDocuments: opts.maxDocuments,
                        maxChunks: opts.maxChunks,
                        isBm25: useBm25,
                        filter: opts.docTypes && opts.docTypes.length > 0
                            ? { docType: { $in: opts.docTypes } }
                            : undefined,
                    })
                    .catch(async (err: unknown) => {
                        // BM25 failures fall back to pure semantic for that
                        // project: tiny corpora hit "collection is too small
                        // for consolidation", large ones can hit vectra's
                        // "Invalid string length" while building the BM25
                        // table. Remember the failure so later queries skip
                        // the doomed build; either way the semantic path answers.
                        if (useBm25) {
                            this._bm25Broken.add(name);
                            return await index.queryDocuments(query, {
                                maxDocuments: opts.maxDocuments,
                                maxChunks: opts.maxChunks,
                                filter: opts.docTypes && opts.docTypes.length > 0
                                    ? { docType: { $in: opts.docTypes } }
                                    : undefined,
                            });
                        }
                        throw err;
                    })
                    .then((results) => ({ name, index, results }));
            }),
        );

        const errors: SearchResponse['errors'] = [];
        const items: SearchResultItem[] = [];
        for (let i = 0; i < settled.length; i++) {
            const outcome = settled[i];
            if (outcome.status == 'rejected') {
                errors.push({
                    project: candidates[i].name,
                    message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
                });
                continue;
            }
            const { name, index, results } = outcome.value;
            for (const result of results) {
                if (opts.resultLevel === 'chunk') items.push(...await this._toChunkItems(name, result));
                else items.push(await this._toResultItem(name, index, result, opts.snippetTokens));
            }
        }

        const ranked = items
            .filter((item) => item.score >= opts.minScore)
            .sort((a, b) => b.score - a.score);
        const perProject = Math.min(50, Math.max(1, Number(opts.perProjectLimit) || 20));
        const results = opts.resultLevel === 'chunk' && opts.perProjectLimit
            ? candidates.flatMap(c => ranked.filter(r => r.project === c.name).slice(0, perProject))
            : ranked.slice(0, opts.maxResults);

        return {
            ...(opts.resultLevel === 'chunk' ? { resultLevel: 'chunk' as const, model: this.embeddingsModelName, dimensions: this._queryDimensions } : {}),
            query,
            results,
            projectsSearched: candidates.map((candidate) => candidate.name),
            projectsSkipped,
            errors,
            tookMs: Date.now() - start,
        };
    }

    private async _toChunkItems(project: string, result: LocalDocumentResult): Promise<SearchResultItem[]> {
        const raw = await result.loadText();
        const lf = raw.replace(/\r\n/g, '\n');
        const leading = /^\n*/.exec(lf)![0].length;
        const body = lf.slice(leading);
        const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
        const chunks = [...result.chunks].sort((a, b) => b.score - a.score);
        const items: SearchResultItem[] = [];
        for (const chunk of chunks) {
            const meta = chunk.item.metadata;
            const rawStart = Number(meta.startPos), rawEnd = Number(meta.endPos) + 1;
            if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd) || rawStart < 0 || rawEnd <= rawStart || rawEnd > raw.length || !Number.isFinite(chunk.score)) continue;
            const startPos = Math.max(0, raw.slice(0, rawStart).replace(/\r\n/g, '\n').length - leading);
            const endPos = Math.max(startPos, raw.slice(0, rawEnd).replace(/\r\n/g, '\n').length - leading);
            items.push({ project, uri: result.uri, file: result.uri.split(/[\\/]/).pop() || result.uri,
                score: chunk.score, scoreType: 'cosine', bodyHash: hash, startPos, endPos,
                snippet: body.slice(startPos, endPos).trim(), ...(typeof meta.docType === 'string' ? { docType: meta.docType } : {}) });
        }
        return items;
    }

    /**
     * One-shot full sync of a source folder into a project index, with
     * document-type and frontmatter metadata (see `kb-sync`).
     * @returns Number of files tracked after the sync.
     */
    public async syncFolder(project: string, sourceDir: string, options?: SyncOptions): Promise<number> {
        const index = this.getProjectIndex(project);
        await this._ensureProjectFolder(project);
        if (!(await index.isIndexCreated())) {
            await index.createIndex({ version: 1 });
        }
        const result = await syncSourceFolder(index, sourceDir, options?.extensions, options?.excludeDirectories);
        return result.filesTracked;
    }

    /**
     * Starts a continuous watcher that keeps a project index in sync with a
     * source folder (initial full sync, then debounced incremental changes).
     * Metadata-aware. Keep the returned watcher alive; call `stop()` to end it.
     */
    public async watchFolder(project: string, sourceDir: string, options?: SyncOptions): Promise<KbFolderWatcher> {
        return await this._startWatcher(project, sourceDir, options);
    }

    private async _startWatcher(project: string, sourceDir: string, options?: SyncOptions): Promise<KbFolderWatcher> {
        this._requireEmbeddings();
        const index = this.getProjectIndex(project);
        await this._ensureProjectFolder(project);
        if (!(await index.isIndexCreated())) {
            await index.createIndex({ version: 1 });
        }
        const watcher = new KbFolderWatcher(index, path.resolve(sourceDir), {
            extensions: options?.extensions ?? ['.md', '.txt', '.html'],
            debounceMs: options?.debounceMs,
            excludeDirectories: options?.excludeDirectories,
        });
        await watcher.start();
        return watcher;
    }

    /**
     * Deletes a project's index folder (vectors, stored texts, catalog).
     * The project registration itself is managed by the server layer.
     */
    public async deleteProjectIndex(project: string): Promise<void> {
        if (!VectorHub.isValidProjectName(project)) {
            throw new Error(`Invalid project name: '${project}'`);
        }
        this._indexes.delete(project);
        await this._deleteFolderRecursive(path.join(this._rootPath, project));
    }

    /**
     * Recursive delete that works on every FileStorage backend — some
     * in-memory implementations do not cascade `deleteFolder`, so children
     * are removed bottom-up explicitly.
     */
    private async _deleteFolderRecursive(folder: string): Promise<void> {
        if (!(await this._storage.pathExists(folder))) {
            return;
        }
        const entries = await this._storage.listFiles(folder).catch(() => []);
        for (const entry of entries) {
            if (entry.isFolder) {
                await this._deleteFolderRecursive(path.join(folder, entry.name));
            } else {
                await this._storage.deleteFile(path.join(folder, entry.name)).catch(() => undefined);
            }
        }
        await this._storage.deleteFolder(folder).catch(() => undefined);
    }

    private _requireEmbeddings(): void {
        if (!this._embeddings) {
            throw new Error('Embeddings model not configured. Call setEmbeddings() or PUT /api/settings first.');
        }
    }

    /**
     * Creates the project's folder entry explicitly. The real filesystem
     * creates parent directories on write, but in-memory storages such as
     * `VirtualFileStorage` only track folders they are told about — without
     * this call, `listProjects()` cannot see projects on those backends.
     */
    private async _ensureProjectFolder(project: string): Promise<void> {
        try {
            await this._storage.createFolder(path.join(this._rootPath, project));
        } catch {
            // LocalFileStorage.createFolder can fail on restricted paths; the
            // subsequent file write will surface the real error.
        }
    }

    private async _toResultItem(
        project: string,
        index: LocalDocumentIndex,
        result: LocalDocumentResult,
        snippetTokens: number,
    ): Promise<SearchResultItem> {
        let snippet = '';
        try {
            // renderSections(maxTokens, maxSections, overlappingChunks)
            const sections = await result.renderSections(snippetTokens, 1, true);
            snippet = (sections[0]?.text ?? '').replace(/\s+/g, ' ').trim();
        } catch {
            // Snippet is best-effort; score and uri are still useful.
        }

        const item: SearchResultItem = {
            project,
            uri: result.uri,
            score: result.score,
            snippet,
            file: result.uri.split(/[\\/]/).pop() ?? result.uri,
        };

        try {
            // Best-matching chunk (highest score) carries the kb-sync metadata;
            // its document-wide position needs the full chunk list of the doc.
            const chunks = [...result.chunks].sort((a, b) => b.score - a.score);
            const best = chunks[0];
            if (best) {
                const metadata = best.item.metadata as Record<string, unknown>;
                if (typeof metadata.docType == 'string') item.docType = metadata.docType;
                if (typeof metadata.tags == 'string') item.tags = metadata.tags;
                if (typeof metadata.modules == 'string') item.modules = metadata.modules;
                item.startPos = best.item.metadata.startPos;
                item.endPos = best.item.metadata.endPos;

                const documentId = best.item.metadata.documentId;
                const all = await index.listItemsByMetadata({ documentId });
                const sorted = all
                    .map((entry) => entry.metadata.startPos)
                    .sort((a, b) => a - b);
                const position = sorted.indexOf(best.item.metadata.startPos);
                if (position >= 0) {
                    item.chunkIndex = position + 1;
                    item.chunkCount = sorted.length;
                }
            }
        } catch {
            // Metadata enrichment is best-effort.
        }
        return item;
    }
}
