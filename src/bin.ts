import http from 'node:http';
import { HubManager } from './server/manager';
import { createServer } from './server/server';

/**
 * vector-hub CLI
 *
 *   vector-hub serve [--port 8787] [--root ./data]   Start the REST API + visual console
 *   vector-hub sync --project NAME --source DIR      One-shot folder sync into a project
 *   vector-hub watch --project NAME --source DIR     Continuous folder sync (keeps running)
 *
 * Configuration priority: data/hub.json settings (set via UI or PUT /api/settings)
 * first, then the MINIMAX_API_KEY environment variable as a first-run fallback.
 */
async function main(): Promise<void> {
    const [command, ...args] = process.argv.slice(2);
    const get = (name: string): string | undefined => {
        const i = args.indexOf('--' + name);
        return i >= 0 ? args[i + 1] : undefined;
    };

    const manager = await HubManager.load(get('root') ?? process.env.VECTOR_HUB_ROOT ?? './data');
    const hub = manager.hub;

    switch (command) {
        case 'serve': {
            const port = Number(get('port') ?? 8787);
            const server = http.createServer(createServer(manager));
            server.listen(port, () => {
                console.log(`vector-hub serving on http://localhost:${port}`);
                console.log(`  root:       ${hub.rootPath}`);
                console.log(`  embeddings: ${hub.embeddingsModelName ?? 'not configured (open the UI to set up)'}`);
                console.log(`  REST search (shared by UI and AI): http://localhost:${port}/api/search?q=...`);
            });
            await manager.resumeWatchers();
            break;
        }

        case 'sync': {
            const project = get('project');
            const source = get('source');
            if (!project || !source) {
                console.error('Usage: vector-hub sync --project NAME --source DIR');
                process.exit(1);
            }
            const count = await hub.syncFolder(project, source);
            console.log(`Synced ${count} files from ${source} into project '${project}'.`);
            break;
        }

        case 'watch': {
            const project = get('project');
            const source = get('source');
            if (!project || !source) {
                console.error('Usage: vector-hub watch --project NAME --source DIR');
                process.exit(1);
            }
            const watcher = await hub.watchFolder(project, source);
            console.log(`Watching ${watcher.trackedFileCount} files in ${source} -> project '${project}'. Press Ctrl+C to stop.`);
            watcher.on('sync', (uri: string, action: string) => console.log(`  ${action}: ${uri}`));
            watcher.on('error', (err: Error, uri: string) => console.error(`  error syncing ${uri}: ${err.message}`));
            break;
        }

        default:
            console.error('Usage: vector-hub <serve|sync|watch> [options]');
            process.exit(1);
    }
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
});
