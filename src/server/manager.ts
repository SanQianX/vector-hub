import fs from 'node:fs';
import path from 'node:path';
import { VectorHub } from '../core/hub';
import { createMiniMaxEmbeddings, createOpenAIEmbeddings } from '../core/embeddings';
import type { EmbeddingsModel, FolderWatcher } from 'vectra';

/**
 * Embedding provider settings persisted in `hub.json`.
 */
export interface HubSettings {
    provider: 'minimax' | 'openai';
    apiKey: string;
    /** Model name. Defaults to `embo-01` (minimax) or `text-embedding-3-small` (openai). */
    model?: string;
    /** OpenAI-compatible base endpoint (openai provider only). */
    endpoint?: string;
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

const DEFAULT_MODELS: Record<HubSettings['provider'], string> = {
    minimax: 'embo-01',
    openai: 'text-embedding-3-small',
};

/**
 * Owns the `VectorHub` lifecycle for the server: persisted settings
 * (`<root>/hub.json`), embeddings hot-swap, folder imports, watchers, and
 * index rebuilds after a model change.
 */
export class HubManager {
    public readonly hub: VectorHub;
    public readonly rootPath: string;

    private readonly _configPath: string;
    private _config: HubConfigFile = {};
    private readonly _watchers = new Map<string, FolderWatcher>();
    private readonly _embeddingsFactory: EmbeddingsFactory;
    private _rebuild: RebuildStatus = { running: false, total: 0, done: 0, manual: [], errors: [] };

    private constructor(rootPath: string, hub: VectorHub, embeddingsFactory: EmbeddingsFactory) {
        this.rootPath = rootPath;
        this.hub = hub;
        this._configPath = path.join(rootPath, 'hub.json');
        this._embeddingsFactory = embeddingsFactory;
    }

    /**
     * Loads (or creates) the hub at `rootPath`: settings come from
     * `hub.json`, falling back to the `MINIMAX_API_KEY` environment variable,
     * falling back to unconfigured (server still starts, UI guides setup).
     */
    public static async load(rootPath: string, options?: { embeddingsFactory?: EmbeddingsFactory }): Promise<HubManager> {
        const factory = options?.embeddingsFactory ?? defaultEmbeddingsFactory;
        const resolved = path.resolve(rootPath);

        let config: HubConfigFile = {};
        try {
            config = JSON.parse(await fs.promises.readFile(path.join(resolved, 'hub.json'), 'utf8'));
        } catch {
            // No config yet — first run.
        }

        const settings = config.settings?.apiKey
            ? config.settings
            : process.env.MINIMAX_API_KEY
                ? { provider: 'minimax' as const, apiKey: process.env.MINIMAX_API_KEY }
                : undefined;

        const hub = new VectorHub({
            rootPath: resolved,
            embeddings: settings ? factory(normalizeSettings(settings)) : undefined,
        });
        const manager = new HubManager(resolved, hub, factory);
        manager._config = config;
        return manager;
    }

    /** Current settings (as persisted), if configured. */
    public get settings(): HubSettings | undefined {
        return this._config.settings ? normalizeSettings(this._config.settings) : undefined;
    }

    /** Project registrations from `hub.json`. */
    public get registrations(): Record<string, ProjectRegistration> {
        return { ...this._config.projects };
    }

    /** Live rebuild progress. */
    public get rebuildStatus(): RebuildStatus {
        return { ...this._rebuild };
    }

    /**
     * Saves settings, hot-swaps the embeddings model, and — when the model
     * identity changed and indexed projects exist — kicks off an automatic
     * rebuild in the background.
     *
     * @returns The rebuild status if a rebuild was triggered, else undefined.
     */
    public async saveSettings(next: HubSettings): Promise<RebuildStatus | undefined> {
        const normalized = normalizeSettings(next);
        const previousKey = this._modelKey(this.settings);
        const nextKey = this._modelKey(normalized);

        this._config.settings = normalized;
        await this._saveConfig();
        this.hub.setEmbeddings(normalized.apiKey ? this._embeddingsFactory(normalized) : undefined);

        if (previousKey == nextKey) {
            return undefined;
        }

        const indexed = (await this.hub.listProjects()).filter((p) => p.hasIndex);
        if (indexed.length == 0) {
            return undefined;
        }
        // Fire-and-forget: callers poll rebuildStatus.
        void this._rebuildAll();
        return this._rebuild;
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

        const filesTracked = await this.hub.syncFolder(project, real);
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
        const watcher = await this.hub.watchFolder(project, sourceDir);
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
                await this.hub.syncFolder(name, sourceDir);
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
        return [settings.provider, settings.model ?? DEFAULT_MODELS[settings.provider], settings.endpoint ?? ''].join('|');
    }

    private async _saveConfig(): Promise<void> {
        await fs.promises.mkdir(this.rootPath, { recursive: true });
        await fs.promises.writeFile(this._configPath, JSON.stringify(this._config, null, 2), 'utf8');
    }
}

function normalizeSettings(settings: HubSettings): HubSettings {
    if (settings.provider != 'minimax' && settings.provider != 'openai') {
        throw new Error(`Unknown provider: '${settings.provider}' (expected 'minimax' or 'openai')`);
    }
    return {
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model?.trim() || undefined,
        endpoint: settings.endpoint?.trim() || undefined,
    };
}

function defaultEmbeddingsFactory(settings: HubSettings): EmbeddingsModel {
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
