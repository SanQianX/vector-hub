import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VectorHub } from '../core/hub';
import { createMiniMaxEmbeddings, createOpenAIEmbeddings } from '../core/embeddings';
import { KbFolderWatcher } from '../core/kb-sync';
import type { EmbeddingsModel } from 'vectra';

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

    private _config: HubConfigFile = {};
    private readonly _watchers = new Map<string, KbFolderWatcher>();
    private readonly _embeddingsFactory: EmbeddingsFactory;
    private readonly _cliRootPath?: string;
    private _rebuild: RebuildStatus = { running: false, total: 0, done: 0, manual: [], errors: [] };

    private constructor(options: HubManagerOptions, hub: VectorHub, config: HubConfigFile) {
        this.configPath = options.configPath ?? defaultConfigPath();
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

        try {
            config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
        } catch {
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

        const settings = config.settings?.apiKey
            ? normalizeSettings(config.settings)
            : process.env.MINIMAX_API_KEY
                ? normalizeSettings({ provider: 'minimax', apiKey: process.env.MINIMAX_API_KEY })
                : undefined;

        const rootPath = path.resolve(
            options.rootPath ?? config.settings?.rootPath ?? process.env.VECTOR_HUB_ROOT ?? './data',
        );
        const factory = options.embeddingsFactory ?? defaultEmbeddingsFactory;

        const hub = new VectorHub({
            rootPath,
            embeddings: settings ? factory(settings) : undefined,
        });
        const manager = new HubManager(options, hub, config);

        if (migrated || settings?.rootPath == undefined) {
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
        const persisted = this._config.settings;
        if (!persisted?.apiKey) {
            return undefined;
        }
        return normalizeSettings(persisted);
    }

    /** Effective sync extensions. */
    public get extensions(): string[] {
        return this._config.settings?.extensions ?? DEFAULT_EXTENSIONS;
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
        const normalized = normalizeSettings(next);
        const previousModelKey = this._modelKey(this.settings);
        const previousRoot = path.resolve(this._config.settings?.rootPath ?? this.hub.rootPath);

        const nextRoot = path.resolve(normalized.rootPath ?? previousRoot);
        const nextModelKey = this._modelKey(normalized);

        this._config.settings = { ...normalized, rootPath: nextRoot };
        await this._saveConfig();

        let rebuild: RebuildStatus | undefined;

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

        const filesTracked = await this.hub.syncFolder(project, real, { extensions: this.extensions });
        if (watch) {
            await this._startWatcher(project, real);
        }
        return { project, filesTracked };
    }

    /**
     * Deletes a project: stops its watcher, removes its index and its
     * registration. The source folder on disk is never touched.
     */
    public async deleteProject(project: string): Promise<void> {
        await this._stopWatcher(project);
        await this.hub.deleteProjectIndex(project);
        if (this._config.projects?.[project] != undefined) {
            delete this._config.projects[project];
            await this._saveConfig();
        }
    }

    /** Restores watchers for projects registered with `watch: true`. */
    public async resumeWatchers(): Promise<void> {
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
    private async _rebuildAll(): Promise<void> {
        // Mark running synchronously so a caller that returns immediately
        // after triggering still observes the running state.
        this._rebuild = { running: true, total: 0, done: 0, manual: [], errors: [], startedAt: Date.now() };

        const projects = await this.hub.listProjects();
        const rebuildable = projects.filter((p) => p.hasIndex && this._config.projects?.[p.name]?.sourceDir);
        const manual = projects.filter((p) => p.hasIndex && !this._config.projects?.[p.name]?.sourceDir).map((p) => p.name);

        this._rebuild.total = rebuildable.length;
        this._rebuild.manual = manual;

        for (const { name } of rebuildable) {
            this._rebuild.currentProject = name;
            const sourceDir = this._config.projects![name].sourceDir!;
            try {
                await this._stopWatcher(name);
                await this.hub.deleteProjectIndex(name);
                await this.hub.syncFolder(name, sourceDir, { extensions: this.extensions });
                if (this._config.projects![name].watch) {
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

        this._rebuild.running = false;
        this._rebuild.currentProject = undefined;
        this._rebuild.finishedAt = Date.now();
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
        await fs.promises.writeFile(this.configPath, JSON.stringify(this._config, null, 2), 'utf8');
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
