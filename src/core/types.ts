import type { EmbeddingsModel, FileStorage } from '@sanqianx/vectra';

/**
 * Options for constructing a `VectorHub`.
 */
export interface VectorHubOptions {
    /**
     * Root folder that holds one sub-folder per project. Each project
     * sub-folder is a self-contained Vectra `LocalDocumentIndex`.
     */
    rootPath: string;

    /**
     * Embeddings model used by every project index. Pluggable — pass any
     * Vectra `EmbeddingsModel` (see `createMiniMaxEmbeddings` /
     * `createOpenAIEmbeddings` factories, or implement your own). Optional at
     * construction; call `setEmbeddings()` later to configure (search and
     * upsert fail with a clear error until then).
     */
    embeddings?: EmbeddingsModel;

    /**
     * Optional file storage backend. Defaults to `LocalFileStorage`
     * (real filesystem). Pass `VirtualFileStorage` for in-memory indexes
     * (tests, ephemeral usage).
     */
    storage?: FileStorage;
}

/**
 * Status of a project (sub-folder) inside the hub.
 */
export interface ProjectInfo {
    name: string;
    /** Whether an index has been created for the project. */
    hasIndex: boolean;
    /** Number of documents in the project index. */
    docCount: number;
    /** Number of chunks in the project index. */
    chunkCount: number;
}

/**
 * Options for `VectorHub.search()`.
 */
export interface SearchOptions {
    /**
     * Projects to search. Defaults to every project that has an index.
     */
    projects?: string[];

    /**
     * Maximum number of results after merging and sorting. Default 10.
     */
    maxResults?: number;

    /**
     * Maximum documents returned per project before merging. Default 5.
     */
    maxDocuments?: number;

    /**
     * Maximum chunks considered per project. Default 20.
     */
    maxChunks?: number;

    /**
     * Restrict results to these document types (goal / architecture /
     * change / module / index …). Applied as a chunk-metadata filter.
     */
    docTypes?: string[];

    /**
     * Drop results scoring below this cosine similarity. Default 0.
     */
    minScore?: number;

    /**
     * Use hybrid BM25 + semantic scoring. Default false (pure semantic).
     */
    isBm25?: boolean;

    /**
     * Approximate token budget for each result's text snippet. Default 120.
     */
    snippetTokens?: number;
}

/**
 * A single search hit.
 */
export interface SearchResultItem {
    /** Project (sub-folder) the document belongs to. */
    project: string;
    /** Document URI (absolute source path for synced folders). */
    uri: string;
    /** Cosine similarity (or hybrid score when `isBm25` is on). */
    score: number;
    /** Leading text snippet of the best-matching section. */
    snippet: string;
    /** Document type from kb-sync metadata (goal/change/module/…), when present. */
    docType?: string;
    /** Comma-joined frontmatter tags, when present. */
    tags?: string;
    /** Comma-joined affectedModules, when present. */
    modules?: string;
    /** 1-based position of the best-matching chunk within the document. */
    chunkIndex?: number;
    /** Total chunks in the document. */
    chunkCount?: number;
    /** Short file name for display. */
    file?: string;
    /** Best-matching chunk's character span in the indexed body text. */
    startPos?: number;
    endPos?: number;
}

/**
 * Response returned by `VectorHub.search()` — also the JSON shape of
 * `GET /api/search`.
 */
export interface SearchResponse {
    query: string;
    results: SearchResultItem[];
    /** Projects that were actually queried. */
    projectsSearched: string[];
    /** Projects skipped because they have no index yet. */
    projectsSkipped: string[];
    /** Per-project errors; the rest of the results are still returned. */
    errors: { project: string; message: string }[];
    tookMs: number;
}

/**
 * A document to upsert into a project index.
 */
export interface UpsertDocumentOptions {
    project: string;
    uri: string;
    text: string;
    docType?: string;
    metadata?: Record<string, string | number | boolean>;
}

/**
 * Options for `VectorHub.syncFolder()` / `VectorHub.watchFolder()`.
 */
export interface SyncOptions {
    /**
     * File extensions to sync. Default `['.md', '.txt', '.html']`.
     */
    extensions?: string[];

    /**
     * Watch debounce in milliseconds. Default 500.
     */
    debounceMs?: number;
}
