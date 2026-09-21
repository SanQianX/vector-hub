#!/usr/bin/env node
import http from 'node:http';
import { HubManager } from './server/manager';
import { createServer } from './server/server';
import { warmFolderPicker } from './server/folder-picker';

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

    if (command === '-v' || command === '--version' || command === 'version') {
        const { version } = require('../../package.json') as { version: string };
        console.log(`vector-hub v${version}`);
        return;
    }
    if (command === '-h' || command === '--help' || command === 'help' || !command) {
        console.log(`vector-hub <serve|sync|watch> [options]

  serve  [--port 8787] [--root DIR]   Start the REST API + visual console
  sync   --project NAME --source DIR  One-shot folder sync into a project
  watch  --project NAME --source DIR  Continuous folder sync (keeps running)
  -v/--version, -h/--help`);
        return;
    }

    const manager = await HubManager.load({
        rootPath: get('root') ?? process.env.VECTOR_HUB_ROOT,
    });
    const hub = manager.hub;

    switch (command) {
        case 'serve': {
            const port = Number(get('port') ?? 8787);
            const server = http.createServer(createServer(manager));
            server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    console.error(`Port ${port} is already in use — a vector-hub instance may already be running.`);
                    console.error(`  Open http://localhost:${port} to use it, or start on another port: vector-hub serve --port ${port + 1}`);
                    process.exit(1);
                }
                throw err;
            });
            server.listen(port, () => {
                console.log(`vector-hub serving on http://localhost:${port}`);
                console.log(`  root:       ${hub.rootPath}`);
                console.log(`  embeddings: ${hub.embeddingsModelName ?? 'not configured (open the UI to set up)'}`);
                console.log(`  REST search (shared by UI and AI): http://localhost:${port}/api/search?q=...`);
            });
            await manager.resumeWatchers();
            // Compile the folder-picker helper up front so the first "browse…"
            // click pops the dialog in milliseconds instead of paying the
            // powershell + Add-Type startup. Never blocks or crashes serve.
            if (process.env.VECTOR_HUB_DISABLE_PICKER != '1') {
                void warmFolderPicker({ title: '选择知识库文件夹' });
            }
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
