import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { HubManager, HubSettings } from './manager';
import { pickFolder } from './folder-picker';
import { extractMetadata, inferDocType, parseFrontmatter } from '../core/kb-sync';
import { LocalDocument } from 'vectra';

/**
 * Options for `createServer`.
 */
export interface VectorHubServerOptions {
    /**
     * Path to the visual console HTML file. Defaults to the bundled
     * `ui/index.html`, resolved from the package layout or the cwd.
     */
    uiPath?: string;
}

/**
 * Creates a native `http.RequestListener` exposing the hub over REST.
 *
 * @remarks
 * Zero third-party dependencies. Use it standalone
 * (`http.createServer(createServer(manager)).listen(8787)`) or compose it
 * into an existing server. This endpoint set is the single retrieval path
 * shared by the visual console and by AI agents — anything that can reach
 * the server can query the hub identically.
 */
export function createServer(manager: HubManager, options?: VectorHubServerOptions): http.RequestListener {
    const hub = manager.hub;
    const uiCandidates = [
        options?.uiPath,
        // dist/cjs/server/server.js → <package root>/ui/index.html
        path.resolve(__dirname, '../../../ui/index.html'),
        path.resolve(process.cwd(), 'ui/index.html'),
    ].filter((candidate): candidate is string => candidate != undefined);

    return async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = `${req.method ?? 'GET'} ${url.pathname}`;

        try {
            switch (route) {
                case 'GET /':
                case 'GET /index.html':
                    return await serveUi(res, uiCandidates);

                case 'GET /vendor/marked.min.js':
                    return await serveStatic(res, path.resolve(path.dirname(uiCandidatesFallback(uiCandidates)), 'vendor', 'marked.min.js'), 'application/javascript; charset=utf-8');

                case 'GET /api/projects': {
                    const projects = await hub.listProjects();
                    const registrations = manager.registrations;
                    return sendJson(res, 200, {
                        projects: projects.map((project) => ({
                            ...project,
                            sourceDir: registrations[project.name]?.sourceDir,
                            watching: manager.isWatching(project.name),
                        })),
                    });
                }

                case 'GET /api/search': {
                    const query = url.searchParams.get('q');
                    if (!query) {
                        return sendJson(res, 400, { error: "Missing required query parameter 'q'." });
                    }
                    const projects = url.searchParams.get('projects')?.split(',').map((p) => p.trim()).filter(Boolean);
                    const docTypes = url.searchParams.get('docTypes')?.split(',').map((t) => t.trim()).filter(Boolean);
                    const response = await hub.search(query, {
                        projects,
                        docTypes,
                        maxResults: parseNumber(url.searchParams.get('maxResults')),
                        maxDocuments: parseNumber(url.searchParams.get('maxDocuments')),
                        minScore: parseNumber(url.searchParams.get('minScore')),
                        isBm25: url.searchParams.get('isBm25') == 'true',
                    });
                    return sendJson(res, 200, response);
                }

                case 'GET /api/document': {
                    const project = url.searchParams.get('project');
                    const uri = url.searchParams.get('uri');
                    if (!project || !uri) {
                        return sendJson(res, 400, { error: "Missing required query parameters 'project' and 'uri'." });
                    }
                    const document = await readDocument(manager, project, uri);
                    if (!document) {
                        return sendJson(res, 404, { error: 'Document not found in the project index or on disk.' });
                    }
                    return sendJson(res, 200, document);
                }

                case 'POST /api/documents': {
                    const body = await readJsonBody(req);
                    if (!body?.project || !body?.uri || typeof body.text != 'string') {
                        return sendJson(res, 400, { error: "Body must include 'project', 'uri' and 'text'." });
                    }
                    await hub.upsertDocument(body);
                    return sendJson(res, 200, { ok: true, project: body.project, uri: body.uri });
                }

                case 'DELETE /api/documents': {
                    const project = url.searchParams.get('project');
                    const uri = url.searchParams.get('uri');
                    if (!project || !uri) {
                        return sendJson(res, 400, { error: "Missing required query parameters 'project' and 'uri'." });
                    }
                    const deleted = await hub.deleteDocument(project, uri);
                    return sendJson(res, deleted ? 200 : 404, { ok: deleted });
                }

                case 'POST /api/sync': {
                    const body = await readJsonBody(req);
                    if (!body?.project || !body?.sourceDir) {
                        return sendJson(res, 400, { error: "Body must include 'project' and 'sourceDir'." });
                    }
                    const count = await hub.syncFolder(body.project, body.sourceDir, {
                        extensions: Array.isArray(body.extensions) ? body.extensions : undefined,
                    });
                    return sendJson(res, 200, { ok: true, project: body.project, filesTracked: count });
                }

                case 'GET /api/settings': {
                    const settings = manager.settings;
                    return sendJson(res, 200, {
                        configured: settings != undefined,
                        settings: settings
                            ? {
                                ...settings,
                                apiKey: maskApiKey(settings.apiKey),
                                rootPath: manager.hub.rootPath,
                                extensions: manager.extensions,
                                debounceMs: manager.debounceMs,
                            }
                            : { rootPath: manager.hub.rootPath, extensions: manager.extensions, debounceMs: manager.debounceMs },
                    });
                }

                case 'PUT /api/settings': {
                    const body = await readJsonBody(req) as Partial<HubSettings>;
                    if (body?.provider != 'minimax' && body?.provider != 'openai') {
                        return sendJson(res, 400, { error: "Body must include 'provider' of 'minimax' or 'openai'." });
                    }
                    if (typeof body.apiKey != 'string' || body.apiKey.trim().length == 0) {
                        return sendJson(res, 400, { error: "Body must include a non-empty 'apiKey'." });
                    }
                    // A masked key echoed back by the UI means "keep current".
                    const apiKey = body.apiKey.startsWith('****')
                        ? manager.settings?.apiKey ?? body.apiKey
                        : body.apiKey.trim();
                    const rebuild = await manager.saveSettings({
                        provider: body.provider,
                        apiKey,
                        model: typeof body.model == 'string' ? body.model : undefined,
                        endpoint: typeof body.endpoint == 'string' ? body.endpoint : undefined,
                        rootPath: typeof body.rootPath == 'string' && body.rootPath.trim().length > 0
                            ? body.rootPath
                            : manager.hub.rootPath,
                        extensions: Array.isArray(body.extensions)
                            ? body.extensions.filter((e): e is string => typeof e == 'string' && e.trim().length > 0)
                            : manager.extensions,
                        debounceMs: parseFiniteNumber(body.debounceMs) ?? manager.debounceMs,
                    });
                    return sendJson(res, 200, { ok: true, rebuildTriggered: rebuild != undefined });
                }

                case 'GET /api/rebuild/status':
                    return sendJson(res, 200, manager.rebuildStatus);

                case 'POST /api/import': {
                    const body = await readJsonBody(req);
                    if (typeof body?.sourceDir != 'string' || body.sourceDir.trim().length == 0) {
                        return sendJson(res, 400, { error: "Body must include 'sourceDir'." });
                    }
                    const result = await manager.import(
                        body.sourceDir,
                        typeof body.projectName == 'string' ? body.projectName : undefined,
                        body.watch === true,
                    );
                    return sendJson(res, 200, { ok: true, ...result });
                }

                case 'DELETE /api/project': {
                    const name = url.searchParams.get('name');
                    if (!name) {
                        return sendJson(res, 400, { error: "Missing required query parameter 'name'." });
                    }
                    await manager.deleteProject(name);
                    return sendJson(res, 200, { ok: true });
                }

                case 'GET /api/system/pick-folder': {
                    // Loopback-only and no CORS headers: prevents an arbitrary
                    // web page from triggering the native dialog and reading
                    // the selected local path.
                    if (!isLoopbackOrigin(req)) {
                        return sendJsonNoCors(res, 403, { error: 'Forbidden origin.' });
                    }
                    const result = await pickFolder();
                    return sendJsonNoCors(res, 200, result);
                }

                case 'GET /api/health': {
                    const projects = await hub.listProjects();
                    return sendJson(res, 200, {
                        ok: projects.every((project) => project.hasIndex),
                        projects,
                        embeddings: { model: hub.embeddingsModelName ?? 'not configured' },
                    });
                }

                default:
                    if (req.method == 'OPTIONS') {
                        return sendJson(res, 204, {});
                    }
                    return sendJson(res, 404, { error: `No route for ${route}` });
            }
        } catch (err: unknown) {
            const status = (err as { status?: number }).status;
            const message = err instanceof Error ? err.message : String(err);
            return sendJson(res, status ?? 500, { error: message });
        }
    };
}

async function serveUi(res: http.ServerResponse, candidates: string[]): Promise<void> {
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            const html = await fs.promises.readFile(candidate);
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                ...corsHeaders(),
            });
            res.end(html);
            return;
        }
    }
    sendJson(res, 500, { error: 'ui/index.html not found. Pass ServerOptions.uiPath.' });
}

async function serveStatic(res: http.ServerResponse, filePath: string, contentType: string): Promise<void> {
    try {
        const content = await fs.promises.readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentType, ...corsHeaders() });
        res.end(content);
    } catch {
        sendJson(res, 404, { error: `Not found: ${path.basename(filePath)}` });
    }
}

function uiCandidatesFallback(candidates: string[]): string {
    return candidates[candidates.length - 1] ?? path.resolve(process.cwd(), 'ui', 'index.html');
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            if (chunks.length == 0) {
                return resolve(undefined);
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (err: unknown) {
                reject(new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
            }
        });
        req.on('error', reject);
    });
}

function parseNumber(value: string | null): number | undefined {
    if (value == undefined || value == '') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFiniteNumber(value: unknown): number | undefined {
    return typeof value == 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Loads a document for the viewer drawer: prefers the live source file
 * (only when the uri lies under the project's registered source folder —
 * this is an arbitrary-file-read guard), falls back to the indexed copy.
 * Returns frontmatter-derived metadata alongside the body text.
 */
async function readDocument(
    manager: HubManager,
    project: string,
    uri: string,
): Promise<Record<string, unknown> | null> {
    const registration = manager.registrations[project];
    let text: string | null = null;
    let sourceExists = false;

    if (registration?.sourceDir) {
        const root = path.resolve(registration.sourceDir);
        const target = path.resolve(uri);
        if (target.startsWith(root + path.sep) || target == root) {
            try {
                text = await fs.promises.readFile(target, 'utf8');
                sourceExists = true;
            } catch {
                // Source file gone — fall through to the indexed copy.
            }
        }
    }
    if (text == null) {
        try {
            const index = manager.hub.getProjectIndex(project);
            const documentId = await index.getDocumentId(uri);
            if (documentId) {
                text = await new LocalDocument(index, documentId, uri).loadText();
            }
        } catch {
            // Not indexed either.
        }
    }
    if (text == null) {
        return null;
    }

    const parsed = parseFrontmatter(text);
    const metadata = extractMetadata(inferDocType(uri, registration?.sourceDir ?? path.dirname(uri)), parsed.meta);
    return {
        uri,
        text: parsed.body,
        frontmatterLength: parsed.frontmatterLength,
        sourceExists,
        ...metadata,
    };
}

function isLoopbackOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin == undefined) {
        return true; // non-browser clients (curl, AI services) send no Origin
    }
    try {
        const { hostname } = new URL(origin);
        return hostname == 'localhost' || hostname == '127.0.0.1' || hostname == '[::1]' || hostname == '::1';
    } catch {
        return false;
    }
}

function maskApiKey(apiKey: string): string {
    if (apiKey.length <= 4) {
        return '****';
    }
    return `****${apiKey.slice(-4)}`;
}

function corsHeaders(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
    res.end(JSON.stringify(body));
}

function sendJsonNoCors(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
