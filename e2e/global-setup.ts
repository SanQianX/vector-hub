import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * E2E fixture: hermetic server on :8791 with mock embeddings
 * (VECTOR_HUB_EMBEDDINGS=mock), the native folder picker disabled, and a
 * seeded minimal-kb knowledge folder on disk. The UI starts unconfigured so
 * tests can drive the setup flow end to end.
 */

export interface E2EFixture {
    serverPid: number;
    seedDir: string;
    workDir: string;
}

let child: ChildProcess | undefined;

async function waitForHealth(url: string, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                return;
            }
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`server did not become healthy at ${url}`);
}

export default async function globalSetup(): Promise<E2EFixture> {
    // Free :8791 from a stale run before spawning (Windows only guard).
    if (process.platform == 'win32') {
        try {
            const out = spawnSync('netstat -ano | findstr :8791 | findstr LISTENING', { shell: true, encoding: 'utf8' }).stdout ?? '';
            const pid = out.trim().split(/\s+/).pop() ?? '';
            if (/^\d+$/.test(pid)) {
                spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { shell: true });
                await new Promise((r) => setTimeout(r, 800));
            }
        } catch {
            // port already free
        }
    }
    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vector-hub-e2e-'));
    const seedDir = path.join(workDir, 'seed-kb');
    const dataRoot = path.join(workDir, 'data');
    await fs.promises.mkdir(path.join(seedDir, 'changes'), { recursive: true });
    await fs.promises.mkdir(path.join(seedDir, 'modules'), { recursive: true });

    // minimal-kb shaped corpus with distinctive tokens for the mock embeddings
    await fs.promises.writeFile(
        path.join(seedDir, 'GOAL.md'),
        ['---', 'title: E2E 目标', 'status: living', 'tags: [goal, alpha]', '---', '', '# 目标', '', 'alpha 目标文档。alpha 帮助开发者回顾用量。'].join('\n'),
    );
    await fs.promises.writeFile(
        path.join(seedDir, 'ARCHITECTURE.md'),
        ['---', 'title: E2E 架构', '---', '', '# 架构', '', 'gamma 架构说明，数据流与模块划分。'].join('\n'),
    );
    await fs.promises.writeFile(
        path.join(seedDir, 'changes', '00-index.md'),
        ['# Changes Index', '', '| Change |', '|---|', '| [实时计数器](./2026-01-01_ab12_live.md) |'].join('\n'),
    );
    await fs.promises.writeFile(
        path.join(seedDir, 'changes', '2026-01-01_ab12_live.md'),
        ['---', 'commit: ab12cd34ef56', 'date: 2026-01-01', 'affectedModules:', '  - live', '---', '', '# 实时计数器', '', 'delta 修复实时计数问题。'].join('\n'),
    );
    await fs.promises.writeFile(
        path.join(seedDir, 'modules', 'live.md'),
        ['---', 'module: live', 'tags: [sse]', '---', '', '# live 模块', '', 'beta 实时模块说明。', '', '## 关联变更', '', '- [变更记录](../changes/2026-01-01_ab12_live.md)'].join('\n'),
    );

    child = spawn('npx', ['tsx', 'src/bin.ts', 'serve', '--port', '8791', '--root', dataRoot], {
        cwd: path.resolve(__dirname, '..'),
        shell: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            VECTOR_HUB_CONFIG: path.join(workDir, 'config.json'),
            VECTOR_HUB_EMBEDDINGS: 'mock',
            VECTOR_HUB_DISABLE_PICKER: '1',
            MINIMAX_API_KEY: '',
        },
    });

    await waitForHealth('http://127.0.0.1:8791/api/health');
    process.env.E2E_SEED_DIR = seedDir;
    process.on('exit', () => {
        if (child && process.platform == 'win32') {
            // Synchronous tree-kill: an async spawn can lose the race with exit.
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true });
        } else {
            child?.kill('SIGTERM');
        }
    });
    return { serverPid: child.pid!, seedDir, workDir };
}

export async function teardown(): Promise<void> {
    // handled by the exit hook above
}
