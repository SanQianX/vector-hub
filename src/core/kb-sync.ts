import fs from 'node:fs';
import path from 'node:path';
import type { LocalDocumentIndex } from 'vectra';

/**
 * Metadata-aware folder synchronization for structured knowledge bases.
 *
 * Vectra's own FolderWatcher syncs plain text only — frontmatter and document
 * types never reach the index. This module layers that in:
 * - `inferDocType` classifies files by path (goal / architecture / change /
 *   module / index / …) using the minimal-kb layout conventions.
 * - `parseFrontmatter` extracts the YAML header (tags, affectedModules,
 *   commit, date, module, title, status) into scalar chunk metadata.
 * - `syncSourceFolder` / `KbFolderWatcher` upsert/delete documents with the
 *   derived metadata, replacing the bare FolderWatcher in the sync path.
 *
 * Indexed text is the frontmatter-stripped body, so chunk startPos/endPos
 * alignment is 1:1 with the rendered body shown in the document drawer.
 */

/** Path-derived document type (stored as chunk metadata `docType`). */
export type KbDocType =
    | 'goal'
    | 'architecture'
    | 'readme'
    | 'change'
    | 'change-index'
    | 'module'
    | 'module-index'
    | 'doc';

/**
 * Classifies a file by its path relative to the source root.
 *
 * Rules (minimal-kb layout):
 * - root GOAL.md / ARCHITECTURE.md / README.md
 * - changes/00-index.md → change-index, changes/* → change
 * - modules/00-index.md → module-index, modules/* → module
 * - anything else → first directory name, or 'doc' at the root
 */
export function inferDocType(absFilePath: string, rootDir: string): KbDocType {
    const rel = path.relative(path.resolve(rootDir), path.resolve(absFilePath));
    const parts = rel.split(/[\\/]/).filter((p) => p.length > 0 && p != '.');
    const base = (parts[parts.length - 1] ?? '').toLowerCase();

    if (parts.length <= 1) {
        if (base == 'goal.md') return 'goal';
        if (base == 'architecture.md') return 'architecture';
        if (base == 'readme.md') return 'readme';
        return 'doc';
    }
    const firstDir = parts[0].toLowerCase();
    if (firstDir == 'changes') {
        return base == '00-index.md' ? 'change-index' : 'change';
    }
    if (firstDir == 'modules') {
        return base == '00-index.md' ? 'module-index' : 'module';
    }
    return 'doc';
}

export interface ParsedFrontmatter {
    /** Raw key → scalar or list values (lists keep their array form here). */
    meta: Record<string, string | string[]>;
    /** Text after the closing `---`, leading newline stripped. */
    body: string;
    /** Number of characters the frontmatter block occupied (incl. delimiters). */
    frontmatterLength: number;
}

/**
 * Minimal YAML frontmatter parser: `key: value`, inline `[a, b]` lists, and
 * block lists (`- item` lines). Comments and nesting are not supported —
 * the minimal-kb schema needs neither.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
    if (!text.startsWith('---')) {
        return { meta: {}, body: text, frontmatterLength: 0 };
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(eol);
    // lines[0] is the opening '---' (possibly with trailing spaces).
    let closeIndex = -1;
    for (let i = 1; i < lines.length; i++) {
        if (/^---\s*$/.test(lines[i])) {
            closeIndex = i;
            break;
        }
    }
    if (closeIndex < 0) {
        return { meta: {}, body: text, frontmatterLength: 0 };
    }

    const meta: Record<string, string | string[]> = {};
    let currentKey: string | null = null;
    for (let i = 1; i < closeIndex; i++) {
        const line = lines[i];
        const listMatch = /^\s+-\s+(.*)$/.exec(line);
        if (listMatch && currentKey) {
            const existing = meta[currentKey];
            const value = listMatch[1].trim().replace(/^['"]|['"]$/g, '');
            if (Array.isArray(existing)) {
                existing.push(value);
            } else {
                meta[currentKey] = existing != undefined ? [existing, value] : [value];
            }
            continue;
        }
        const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (kv) {
            const key = kv[1];
            const raw = kv[2].trim();
            currentKey = key;
            if (raw == '') {
                // Might be followed by a block list; leave undefined for now.
                meta[key] = [];
            } else if (raw.startsWith('[') && raw.endsWith(']')) {
                meta[key] = raw
                    .slice(1, -1)
                    .split(',')
                    .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
                    .filter((v) => v.length > 0);
            } else {
                meta[key] = raw.replace(/^['"]|['"]$/g, '');
            }
        }
    }

    const body = lines.slice(closeIndex + 1).join(eol).replace(/^\r?\n/, '');
    const frontmatterLength = text.length - body.length - (text.length > 0 && body.length == 0 ? 0 : 0);
    return { meta, body, frontmatterLength };
}

/**
 * Frontmatter keys promoted to chunk metadata. Arrays are comma-joined —
 * Vectra metadata values must be scalars.
 */
const PROMOTED_KEYS = ['title', 'status', 'commit', 'date', 'module', 'tags', 'affectedModules'] as const;

export interface KbDocumentMetadata {
    docType: KbDocType;
    title?: string;
    status?: string;
    commit?: string;
    date?: string;
    module?: string;
    tags?: string;
    modules?: string;
    [key: string]: string | number | boolean | undefined;
}

/** Derives chunk metadata for a file from its type and frontmatter. */
export function extractMetadata(docType: KbDocType, frontmatter: ParsedFrontmatter['meta']): KbDocumentMetadata {
    const metadata: KbDocumentMetadata = { docType };
    for (const key of PROMOTED_KEYS) {
        const value = frontmatter[key];
        if (value == undefined) {
            continue;
        }
        const scalar = Array.isArray(value) ? value.filter((v) => v.length > 0).join(', ') : value;
        if (typeof scalar == 'string' && scalar.length > 0) {
            if (key == 'affectedModules') {
                metadata.modules = scalar;
            } else {
                metadata[key] = scalar;
            }
        }
    }
    return metadata;
}

/** Reads one file and returns what should be indexed: body text + metadata. */
export function buildDocument(absFilePath: string, rootDir: string, text: string): {
    uri: string;
    text: string;
    metadata: KbDocumentMetadata;
} {
    const parsed = parseFrontmatter(text);
    const docType = inferDocType(absFilePath, rootDir);
    return {
        uri: path.resolve(absFilePath),
        text: parsed.body,
        metadata: extractMetadata(docType, parsed.meta),
    };
}

async function* walkFiles(dir: string, extensions: Set<string>): AsyncAsyncGeneratorShim {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walkFiles(full, extensions);
        } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
            yield full;
        }
    }
}
// Small helper type so the generator signature stays readable.
type AsyncAsyncGeneratorShim = AsyncGenerator<string, void, unknown>;

export interface SyncFolderResult {
    /** Files present after the sync. */
    filesTracked: number;
    /** Documents removed because their file disappeared. */
    deleted: number;
}

/**
 * Full sync of a source folder into a document index with metadata. Files
 * absent from disk are removed from the index (Vectra's hash-based skip
 * makes unchanged files a no-op).
 */
export async function syncSourceFolder(
    index: LocalDocumentIndex,
    sourceDir: string,
    extensions: string[] = ['.md', '.txt', '.html'],
): Promise<SyncFolderResult> {
    const root = path.resolve(sourceDir);
    const exts = new Set(extensions.map((e) => e.toLowerCase()));

    const diskFiles = new Set<string>();
    for await (const file of walkFiles(root, exts)) {
        diskFiles.add(file);
        const text = await fs.promises.readFile(file, 'utf8');
        const doc = buildDocument(file, root, text);
        await index.upsertDocument(doc.uri, doc.text, path.extname(file).slice(1).toLowerCase(), doc.metadata as Record<string, string>);
    }

    // Delete indexed documents whose file no longer exists.
    let deleted = 0;
    const documents = await index.listDocuments();
    for (const document of documents) {
        if (!diskFiles.has(document.uri)) {
            await index.deleteDocument(document.uri);
            deleted++;
        }
    }

    return { filesTracked: diskFiles.size, deleted };
}

/**
 * Watches a source folder and keeps the index in sync (initial full sync on
 * start, then debounced incremental add/change/delete). Replaces Vectra's
 * FolderWatcher for paths that need metadata.
 */
export class KbFolderWatcher {
    private _watcher: fs.FSWatcher | null = null;
    private _stopped = false;
    private _tracked = 0;
    private readonly _pending = new Map<string, NodeJS.Timeout>();

    public constructor(
        private readonly index: LocalDocumentIndex,
        private readonly sourceDir: string,
        private readonly options: { extensions?: string[]; debounceMs?: number } = {},
    ) {}

    public get isRunning(): boolean {
        return this._watcher != null;
    }

    public get trackedFileCount(): number {
        return this._tracked;
    }

    public async start(): Promise<void> {
        const result = await syncSourceFolder(this.index, this.sourceDir, this.options.extensions);
        this._tracked = result.filesTracked;
        if (this._stopped) {
            return;
        }
        // recursive: true is supported on Windows and macOS; on Linux it
        // falls back to watching the top level only (per-project knowledge
        // bases are shallow enough for v1).
        this._watcher = fs.watch(this.sourceDir, { recursive: true }, (_event, filename) => {
            const relative = String(filename ?? '');
            if (!relative || path.basename(relative).startsWith('.')) {
                return;
            }
            this._schedule(path.join(this.sourceDir, relative));
        });
    }

    public async stop(): Promise<void> {
        this._stopped = true;
        for (const timer of this._pending.values()) {
            clearTimeout(timer);
        }
        this._pending.clear();
        this._watcher?.close();
        this._watcher = null;
    }

    private _schedule(absPath: string): void {
        const existing = this._pending.get(absPath);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this._pending.delete(absPath);
            void this._syncFile(absPath);
        }, this.options.debounceMs ?? 500);
        this._pending.set(absPath, timer);
    }

    private async _syncFile(absPath: string): Promise<void> {
        const exts = new Set((this.options.extensions ?? ['.md', '.txt', '.html']).map((e) => e.toLowerCase()));
        try {
            const stat = await fs.promises.stat(absPath);
            if (!stat.isFile() || !exts.has(path.extname(absPath).toLowerCase())) {
                return;
            }
            const text = await fs.promises.readFile(absPath, 'utf8');
            const doc = buildDocument(absPath, this.sourceDir, text);
            await this.index.upsertDocument(doc.uri, doc.text, path.extname(absPath).slice(1).toLowerCase(), doc.metadata as Record<string, string>);
        } catch {
            // File vanished between event and sync — treat as delete.
            try {
                await this.index.deleteDocument(path.resolve(absPath));
            } catch {
                /* nothing to delete */
            }
        }
    }
}
