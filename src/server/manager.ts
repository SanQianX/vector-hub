import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { VectorHub } from '../core/hub';
import { createMiniMaxEmbeddings, createOpenAIEmbeddings } from '../core/embeddings';
import { KbFolderWatcher } from '../core/kb-sync';
import type { SyncOptions } from '../core/types';
import type { EmbeddingsModel } from '@sanqianx/vectra';

/**
 * Embedding provider + data/sync settings persisted in the global config
 * file (`~/.vector-hub/config.json` by default — deliberately OUTSIDE the
 * data directory so switching the data root keeps registrations).
 */
export interface HubSettings {
    provider: 'minimax' | 'openai';
    apiKey: string;
    /** Model name. Defaults to `embo-01` (minimax) or `text-embedding-3-small` (openai). */
    model?: string;
    /** OpenAI-compatible base endpoint (openai provider only). */
    endpoint?: string;
    /** Data directory holding the per-project indexes. Default `./data`. */
    rootPath?: string;
    /** File extensions synced from source folders. Default `['.md', '.txt', '.html']`. */
    extensions?: string[];
    /** Watch debounce in ms. Default 500. */
    debounceMs?: number;
}

/**
 * A project registered through import / the UI. API-written projects may
 * have no registration entry and therefore cannot be auto-rebuilt.
 */
export interface ProjectRegistration {
    sourceDir?: string;
    watch?: boolean;
}

export interface HubConfigFile {
    settings?: HubSettings;
    projects?: Record<string, ProjectRegistration>;
    /** Hash of the last successfully indexed root/model, never a credential. */
    indexIdentity?: string;
}

export interface RebuildStatus {
    running: boolean;
    /** Projects to rebuild (those with a registered sourceDir). */
    total: number;
    done: number;
    currentProject?: string;
    /** Indexed projects without a sourceDir — cannot be rebuilt automatically. */
    manual: string[];
    errors: { project: string; message: string }[];
    startedAt?: number;
    finishedAt?: number;
}

export interface EmbeddingsFactory {
    (settings: HubSettings): EmbeddingsModel;
}

export interface HubManagerOptions {
    /** CLI `--root` override; wins over the configured rootPath. */
    rootPath?: string;
    /** Config file location override (tests). Defaults to `~/.vector-hub/config.json`. */
    configPath?: string;
    /** Embeddings factory override (tests / mock mode). */
    embeddingsFactory?: EmbeddingsFactory;
    /** Shell-managed mode: credentials arrive through the private runtime API. */
    managed?: boolean;
    /** Read-only legacy source; no project registrations are adopted. */
    legacyConfigPath?: string;
}

export const DEFAULT_EXTENSIONS = ['.md', '.txt', '.html'];
const DEFAULT_MODELS: Record<HubSettings['provider'], string> = {
    minimax: 'embo-01',
    openai: 'text-embedding-3-small',
};

/**
 * Owns the `VectorHub` lifecycle for the server: persisted settings, embeddings
 * hot-swap, folder imports, watchers, data-directory switching, and index
 * rebuilds after a model change.
 */
export class HubManager {
    public hub: VectorHub;
    public readonly configPath: string;
    public readonly managed: boolean;
    private _runtimeSettings?: HubSettings;
    private _runtimeSignature = '';

    private _config: HubConfigFile = {};
    private readonly _watchers = new Map<string, KbFolderWatcher>();
    private readonly _embeddingsFactory: EmbeddingsFactory;
    private readonly _cliRootPath?: string;
    private _rebuild: RebuildStatus = { running: false, total: 0, done: 0, manual: [], errors: [] };
    private readonly _projectWrites = new Map<string, Promise<unknown>>();
    private _runtimeChange: Promise<void> = Promise.resolve();

    public async withProjectWrite<T>(project: string, write: () => Promise<T>): Promise<T> {
        if (!VectorHub.isValidProjectName(project)) throw new Error(`Invalid project name: '${project}'`);
        const previous = this._projectWrites.get(project) ?? Promise.resolve();
        const barrier = this._runtimeChange;
        const job = Promise.all([previous.catch(() => undefined), barrier.catch(() => undefined)]).then(write);
        this._projectWrites.set(project, job);
        try { return await job; }
        finally { if (this._projectWrites.get(project) === job) this._projectWrites.delete(project); }
    }

    private async waitForWrites(): Promise<void> {
        while (this._projectWrites.size) await Promise.all([...this._projectWrites.values()].map(job => job.catch(() => undefined)));
    }

    private constructor(options: HubManagerOptions, hub: VectorHub, config: HubConfigFile) {
        this.configPath = options.configPath ?? defaultConfigPath();
        this.managed = options.managed === true;
        this._cliRootPath = options.rootPath;
        this._embeddingsFactory = options.embeddingsFactory ?? defaultEmbeddingsFactory;
        this._config = config;
        this.hub = hub;
    }

    /**
     * Loads (or creates) the manager. Resolution order:
     * settings from the global config file → `MINIMAX_API_KEY` env → unconfigured
     * (server still starts; UI guides setup). Data root resolution:
     * CLI `--root` → configured `settings.rootPath` → `./data`.
     *
     * Legacy `data/hub.json` files are migrated to the global config on first run.
     */
    public static async load(options: HubManagerOptions = {}): Promise<HubManager> {
        const configPath = options.configPath ?? defaultConfigPath();
        let config: HubConfigFile = {};
        let migrated = false;
        let configMissing = false;

        try {
            config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
        } catch {
            configMissing = true;
            // No global config yet — check for a legacy config inside the data dir.
            const cliRoot = options.rootPath ?? process.env.VECTOR_HUB_ROOT ?? './data';
            const legacyPath = path.join(path.resolve(cliRoot), 'hub.json');
            try {
                config = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
                migrated = true;
            } catch {
                // Fresh install.
            }
        }

        if (options.managed && configMissing && options.legacyConfigPath) {
            let legacy: HubConfigFile = {};
            try { legacy = JSON.parse(await fs.promises.readFile(options.legacyConfigPath, 'utf8')); } catch {}
            if (legacy.settings?.apiKey) {
                const settings = normalizeSettings(legacy.settings);
                // Read the old standalone key without adopting its projects or
                // writing back to a service the shell does not own.
                config = { settings: { provider: settings.provider, apiKey: settings.apiKey, model: settings.model, endpoint: settings.endpoint } };
                await fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
                await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            }
        }

        const settings = options.managed ? undefined : config.settings?.apiKey
            ? normalizeSettings(config.settings)
            : process.env.MINIMAX_API_KEY
                ? normalizeSettings({ provider: 'minimax', apiKey: process.env.MINIMAX_API_KEY })
                : undefined;

        const rootPath = path.resolve(
            options.rootPath ?? config.settings?.rootPath ?? process.env.VECTOR_HUB_ROOT ?? './data',
        );
        if (options.managed) {
            await fs.promises.mkdir(rootPath, { recursive: true, mode: 0o700 });
            const stat = await fs.promises.lstat(rootPath);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed index storage must be a real directory');
            await fs.promises.access(rootPath, fs.constants.W_OK);
        }
        const factory = options.embeddingsFactory ?? defaultEmbeddingsFactory;

        const hub = new VectorHub({
            rootPath,
            embeddings: settings ? factory(settings) : undefined,
        });
        const manager = new HubManager(options, hub, config);

        if (!options.managed && (migrated || settings?.rootPath == undefined)) {
            // Persist immediately: record the effective data root (and complete
            // the legacy migration) so the config is authoritative from now on.
            manager._config.settings = settings ? { ...settings, rootPath } : { provider: 'minimax', apiKey: '', rootPath };
            await manager._saveConfig();
            if (migrated) {
                console.log(`[vector-hub] migrated legacy config from ${legacyPathString(rootPath)} to ${configPath}`);
            }
        }
        return manager;
    }

    /** Current settings (as persisted). Undefined while no API key is configured. */
    public get settings(): HubSettings | undefined {
        if (this.managed) return this._runtimeSettings;
        const persisted = this._config.settings;
        if (!persisted?.apiKey) {
            return undefined;
        }
        return normalizeSettings(persisted);
    }

    /** Effective sync extensions. */
    public get extensions(): string[] {
        if (this.managed) return ['.md'];
        return this._config.settings?.extensions ?? DEFAULT_EXTENSIONS;
    }

    public get syncOptions(): SyncOptions {
        return { extensions: this.extensions, ...(this.managed ? { excludeDirectories: ['dev-conversations', '_ai', '_backup', 'node_modules'] } : {}) };
    }

    /** Effective watch debounce. */
    public get debounceMs(): number {
        return this._config.settings?.debounceMs ?? 500;
    }

    /** Project registrations from the config file. */
    public get registrations(): Record<string, ProjectRegistration> {
        return { ...this._config.projects };
    }

    /** Live rebuild progress. */
    public get rebuildStatus(): RebuildStatus {
        return { ...this._rebuild };
    }

    /**
     * Saves settings and applies them:
     * - embeddings identity change → hot-swap model + auto rebuild indexed projects
     * - rootPath change → hot-switch data directory (watchers stopped and resumed)
     *
     * @returns The rebuild status if a rebuild was triggered, else undefined.
     */
    public async saveSettings(next: HubSettings): Promise<RebuildStatus | undefined> {
        if (this.managed) throw Object.assign(new Error('请在智脑的系统状态中配置向量模型。'), { status: 409 });
        const normalized = normalizeSettings(next);
        const previousModelKey = this._modelKey(this.settings);
        const previousRoot = path.resolve(this._config.settings?.rootPath ?? this.hub.rootPath);

        const nextRoot = path.resolve(normalized.rootPath ?? previousRoot);
        const nextModelKey = this._modelKey(normalized);

        this._config.settings = { ...normalized, rootPath: nextRoot };
        await this._saveConfig();

        let rebuild: RebuildStatus | undefined;
        await this.waitForWrites();

        if (nextRoot != previousRoot) {
            await this._switchRoot(nextRoot);
        }
        if (nextModelKey != previousModelKey) {
            this.hub.setEmbeddings(normalized.apiKey ? this._embeddingsFactory(normalized) : undefined);
            const indexed = (await this.hub.listProjects()).filter((p) => p.hasIndex);
            if (indexed.length > 0) {
                void this._rebuildAll();
                rebuild = this._rebuild;
            }
        } else {
            // Same model: just refresh the instance (e.g. key rotation).
            this.hub.setEmbeddings(normalized.apiKey ? this._embeddingsFactory(normalized) : undefined);
        }
        return rebuild;
    }

    public legacyEmbeddingSettings(): HubSettings | null {
        return this._config.settings?.apiKey ? normalizeSettings(this._config.settings) : null;
    }

    public embeddingMigrationId(): string { return `embedding-${crypto.createHash('sha256').update(path.resolve(this.configPath)).digest('hex')}`; }

    public async retireLegacyEmbedding(migrationId: string): Promise<void> {
        if (!this.managed || !/^embedding-[a-f0-9]{64}$/.test(migrationId)) throw new Error('Invalid embedding migration');
        if (!this._config.settings?.apiKey) return;
        const backup = path.join(path.dirname(this.configPath), 'recovery', migrationId, 'vector-config.json');
        await fs.promises.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
        try { await fs.promises.copyFile(this.configPath, backup, fs.constants.COPYFILE_EXCL); await fs.promises.chmod(backup, 0o600); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        this._config.settings = { ...this._config.settings, apiKey: '' };
        await this._saveConfig();
    }

    public async applyRuntimeSettings(input: HubSettings | null, storageRoot?: string): Promise<void> {
        if (!this.managed) throw new Error('Vector runtime is not shell-managed');
        const next = input ? normalizeSettings(input) : undefined;
        if (next && (!next.apiKey || typeof next.apiKey !== 'string')) throw new Error('Embedding credential required');
        if (storageRoot !== undefined && (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot))) throw new Error('Absolute index storage directory required');
        const signature = crypto.createHash('sha256').update(JSON.stringify({ next: next || null, storageRoot: storageRoot || null })).digest('hex');
        const pending = [...this._projectWrites.values()];
        const previous = this._runtimeChange;
        const change = previous.catch(() => undefined).then(async () => {
            if (signature === this._runtimeSignature) return;
            if (this._rebuild.running) throw new Error('Index rebuild is running; retry configuration after completion');
            // Only pre-change writers are awaited. New writers wait on this
            // barrier, so they cannot touch a stale hub or deadlock the switch.
            await Promise.all(pending.map(job => job.catch(() => undefined)));
            const newRoot = storageRoot ? path.resolve(storageRoot) : this.hub.rootPath;
            const rootChanged = newRoot !== this.hub.rootPath;
            if (rootChanged) {
                await fs.promises.mkdir(newRoot, { recursive: true, mode: 0o700 });
                const stat = await fs.promises.lstat(newRoot);
                if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Index storage must be a real directory');
                await fs.promises.access(newRoot, fs.constants.W_OK);
                const oldConfig = this._config.settings;
                this._config.settings = { provider: 'minimax', apiKey: '', ...oldConfig, rootPath: newRoot };
                try { await this._saveConfig(); } catch (error) { this._config.settings = oldConfig; throw error; }
                await this._switchRoot(newRoot);
            }
            this._runtimeSettings = next;
            this._runtimeSignature = signature;
            this.hub.setEmbeddings(next ? this._embeddingsFactory(next) : undefined);
            const identity = this._indexIdentity();
            if (next && this._config.indexIdentity !== identity) {
                if (Object.keys(this._config.projects ?? {}).length) void this._rebuildAll(true, identity);
                else {
                    const previousIdentity = this._config.indexIdentity;
                    this._config.indexIdentity = identity;
                    try { await this._saveConfig(); }
                    catch (error) { this._config.indexIdentity = previousIdentity; this._runtimeSignature = ''; throw error; }
                }
            }
        });
        this._runtimeChange = change;
        await change;
    }

    /**
     * Switches the data directory at runtime: stops watchers, points the hub
     * at the new root (indexes there are simply absent until re-synced), and
     * resumes watchers for registered projects. The old directory is untouched.
     */
    private async _switchRoot(newRoot: string): Promise<void> {
        for (const project of [...this._watchers.keys()]) {
            await this._stopWatcher(project);
        }
        this.hub = new VectorHub({ rootPath: newRoot });
        console.log(`[vector-hub] data directory switched to ${newRoot}`);
        await this.resumeWatchers();
    }

    /**
     * Imports a local folder as a project: resolves the real path, registers
     * the mapping, syncs the folder into the index, and optionally starts a
     * continuous watcher.
     */
    public async import(sourceDir: string, projectName?: string, watch?: boolean): Promise<{ project: string; filesTracked: number }> {
        // The managed product indexes only after promotion. A legacy watcher
        // would race that completion boundary and expose half-written updates.
        if (this.managed) watch = false;
        const real = await fs.promises.realpath(sourceDir);
        const stat = await fs.promises.stat(real);
        if (!stat.isDirectory()) {
            throw new Error(`Not a folder: ${real}`);
        }

        const project = projectName?.trim() || path.basename(real);
        if (!VectorHub.isValidProjectName(project)) {
            throw new Error(`Invalid project name derived from folder: '${project}'`);
        }

        this._config.projects = this._config.projects ?? {};
        this._config.projects[project] = { sourceDir: real, watch: watch ?? this._config.projects[project]?.watch };
        await this._saveConfig();

        const filesTracked = await this.withProjectWrite(project, () => this.hub.syncFolder(project, real, this.syncOptions));
        if (watch) {
            await this._startWatcher(project, real);
        } else if (watch === false) {
            await this._stopWatcher(project);
        }
        return { project, filesTracked };
    }

    /**
     * Deletes a project: stops its watcher, removes its index and its
     * registration. The source folder on disk is never touched.
     */
    public async deleteProject(project: string): Promise<void> {
        await this._stopWatcher(project);
        await this.withProjectWrite(project, () => this.hub.deleteProjectIndex(project));
        if (this._config.projects?.[project] != undefined) {
            delete this._config.projects[project];
            await this._saveConfig();
        }
    }

    /** Restores watchers for projects registered with `watch: true`. */
    public async resumeWatchers(): Promise<void> {
        if (this.managed) {
            let changed = false;
            for (const [project, registration] of Object.entries(this._config.projects ?? {})) {
                await this._stopWatcher(project);
                if (registration.watch) { registration.watch = false; changed = true; }
            }
            if (changed) await this._saveConfig();
            return;
        }
        for (const [project, registration] of Object.entries(this._config.projects ?? {})) {
            if (registration.watch && registration.sourceDir && !this._watchers.has(project)) {
                try {
                    await this._startWatcher(project, registration.sourceDir);
                } catch (err: unknown) {
                    console.error(`[vector-hub] failed to resume watcher for '${project}': ${err instanceof Error ? err.message : err}`);
                }
            }
        }
    }

    public isWatching(project: string): boolean {
        return this._watchers.has(project);
    }

    private async _startWatcher(project: string, sourceDir: string): Promise<void> {
        await this._stopWatcher(project);
        const watcher = await this.hub.watchFolder(project, sourceDir, {
            extensions: this.extensions,
            debounceMs: this.debounceMs,
        });
        this._watchers.set(project, watcher);
    }

    private async _stopWatcher(project: string): Promise<void> {
        const watcher = this._watchers.get(project);
        if (watcher) {
            this._watchers.delete(project);
            await watcher.stop().catch(() => undefined);
        }
    }

    /**
     * Rebuilds every indexed project that has a registered sourceDir with the
     * current (new) embeddings model. Indexed projects without a sourceDir
     * are reported as `manual`.
     */
    private async _rebuildAll(includeMissing = false, identity?: string): Promise<void> {
        // Mark running synchronously so a caller that returns immediately
        // after triggering still observes the running state.
        this._rebuild = { running: true, total: 0, done: 0, manual: [], errors: [], startedAt: Date.now() };

        try {
            const projects = await this.hub.listProjects();
            const rebuildable = includeMissing
                ? Object.entries(this._config.projects ?? {}).filter(([, registration]) => registration.sourceDir).map(([name]) => ({ name }))
                : projects.filter((p) => p.hasIndex && this._config.projects?.[p.name]?.sourceDir);
            const manual = projects.filter((p) => p.hasIndex && !this._config.projects?.[p.name]?.sourceDir).map((p) => p.name);

            this._rebuild.total = rebuildable.length;
            this._rebuild.manual = manual;

            for (const { name } of rebuildable) {
                this._rebuild.currentProject = name;
                const sourceDir = this._config.projects![name].sourceDir!;
                try {
                    await this._stopWatcher(name);
                    // Delete + rebuild is one write lease, shared with HTTP sync.
                    await this.withProjectWrite(name, async () => {
                        await this.hub.deleteProjectIndex(name);
                        await this.hub.syncFolder(name, sourceDir, this.syncOptions);
                    });
                    if (!this.managed && this._config.projects![name].watch) {
                        await this._startWatcher(name, sourceDir);
                    }
                } catch (err: unknown) {
                    this._rebuild.errors.push({
                        project: name,
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
                this._rebuild.done++;
            }

            if (identity && !this._rebuild.errors.length && identity === this._indexIdentity()) {
                const previousIdentity = this._config.indexIdentity;
                this._config.indexIdentity = identity;
                try { await this._saveConfig(); }
                catch (error) { this._config.indexIdentity = previousIdentity; throw error; }
            }
        } catch (error) {
            this._rebuild.errors.push({ project: '', message: error instanceof Error ? error.message : String(error) });
        } finally {
            if (identity && this._rebuild.errors.length) this._runtimeSignature = '';
            this._rebuild.running = false;
            this._rebuild.currentProject = undefined;
            this._rebuild.finishedAt = Date.now();
        }
    }

    private _indexIdentity(): string {
        return crypto.createHash('sha256').update(`${this.hub.rootPath}|${this._modelKey(this._runtimeSettings)}${this.managed ? '|managed-markdown-no-evidence-v1' : ''}`).digest('hex');
    }

    private _modelKey(settings?: HubSettings): string {
        if (!settings) {
            return 'none';
        }
        return [
            settings.provider,
            settings.model ?? DEFAULT_MODELS[settings.provider],
            settings.endpoint ?? '',
        ].join('|');
    }

    private async _saveConfig(): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.configPath), { recursive: true });
        const temporary = `${this.configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.promises.writeFile(temporary, JSON.stringify(this._config, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.promises.rename(temporary, this.configPath);
    }
}

function legacyPathString(rootPath: string): string {
    return path.join(rootPath, 'hub.json');
}

export function defaultConfigPath(): string {
    const override = process.env.VECTOR_HUB_CONFIG;
    if (override) {
        return path.resolve(override);
    }
    return path.join(os.homedir(), '.vector-hub', 'config.json');
}

function normalizeSettings(settings: HubSettings): HubSettings {
    if (settings.provider != 'minimax' && settings.provider != 'openai') {
        throw new Error(`Unknown provider: '${settings.provider}' (expected 'minimax' or 'openai')`);
    }
    const normalized: HubSettings = {
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model?.trim() || undefined,
        endpoint: settings.endpoint?.trim() || undefined,
    };
    if (settings.rootPath?.trim()) {
        normalized.rootPath = settings.rootPath.trim();
    }
    if (Array.isArray(settings.extensions) && settings.extensions.length > 0) {
        normalized.extensions = settings.extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
    }
    if (Number.isFinite(settings.debounceMs) && (settings.debounceMs as number) > 0) {
        normalized.debounceMs = settings.debounceMs;
    }
    return normalized;
}

function defaultEmbeddingsFactory(settings: HubSettings): EmbeddingsModel {
    if (process.env.VECTOR_HUB_EMBEDDINGS == 'mock') {
        // Hermetic mode for E2E/perf tests — deterministic bag-of-words vectors.
        return createMockEmbeddings();
    }
    if (settings.provider == 'minimax') {
        return createMiniMaxEmbeddings(settings.apiKey, {
            model: settings.model,
            endpoint: settings.endpoint,
        });
    }
    return createOpenAIEmbeddings({
        apiKey: settings.apiKey,
        model: settings.model ?? DEFAULT_MODELS.openai,
        endpoint: settings.endpoint,
    });
}

/** Deterministic embeddings for tests — 64-dim hashed bag-of-words. */
export function createMockEmbeddings(): EmbeddingsModel & { model: string } {
    const model: EmbeddingsModel & { model: string } = {
        maxTokens: 500,
        model: 'mock-bow-64',
        async createEmbeddings(inputs: string | string[]) {
            const texts = Array.isArray(inputs) ? inputs : [inputs];
            return { status: 'success', output: texts.map((t) => bowEmbed(t)) };
        },
    };
    return model;
}

function bowEmbed(text: string): number[] {
    const vector: number[] = new Array(64).fill(0);
    // Unicode-aware tokens (\W would drop CJK entirely and produce all-zero
    // vectors → NaN cosine scores in tests).
    for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (word.length == 0) {
            continue;
        }
        let hash = 0;
        for (const ch of word) {
            hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
        }
        vector[hash % 64] += 1;
    }
    // reduce (not every()) — a narrowable every() would type the array as 0[]
    // and reject the fallback assignment below.
    if (vector.reduce((a, b) => a + b, 0) == 0) {
        // Token-less text still needs a non-zero vector to keep cosine defined.
        vector[0] = 1;
    }
    return vector;
}
