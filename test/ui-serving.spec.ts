import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Executes the BUILT package as native JS in a child process (no ts-node),
// from an unrelated cwd with a fake ui/ that has no vendor assets. A real
// HubManager and HTTP service must serve the bundled HTML and vendor bytes;
// an explicit uiPath overrides both from its own directory.

const repoRoot = path.resolve(__dirname, '..');
const nl = String.fromCharCode(10);
const pkgVersion = (require('../package.json') as { version: string }).version;

function runNpm(args: string[]) {
    const npmCli = process.env.npm_execpath;
    if (npmCli) {
        return spawnSync(process.execPath, [npmCli, ...args], { cwd: repoRoot, encoding: 'utf8' });
    }
    return spawnSync('npm', args, { cwd: repoRoot, shell: true, encoding: 'utf8' });
}

function buildFromSources(): void {
    const run = runNpm(['run', 'build']);
    assert.equal(run.status, 0, `npm run build failed: ${run.stderr || run.stdout}`);
}

function toUrl(p: string): string {
    return 'file:///' + p.split(path.sep).join('/');
}

function probe(esm: boolean, uiPath: string | null): string {
    const entry = esm ? path.join(repoRoot, 'dist', 'esm', 'index.js') : path.join(repoRoot, 'dist', 'cjs', 'index.js');
    const loader = esm ? 'const m = await import(' + JSON.stringify(toUrl(entry)) + ');' : 'const m = require(' + JSON.stringify(entry) + ');';
    const ui = uiPath == null ? 'undefined' : '{ uiPath: ' + JSON.stringify(uiPath) + ' }';
    return [
        "const http = " + (esm ? "await import('node:http');" : "require('node:http');"),
        loader,
        '(async () => {',
        '  const manager = await m.HubManager.load({',
        '    rootPath: process.env.PROBE_ROOT,',
        '    configPath: process.env.PROBE_CONFIG,',
        "    embeddingsFactory: () => ({ maxTokens: 500, model: 'probe', async createEmbeddings(x) { const t = Array.isArray(x) ? x : [x]; return { status: 'success', output: t.map(() => [1, 0]) }; } }),",
        '  });',
        '  const server = http.createServer(m.createServer(manager, ' + ui + '));',
        "  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
        '  const base = ' + JSON.stringify('http://127.0.0.1:') + ' + server.address().port;',
        "  const htmlRes = await fetch(base + '/');",
        '  const html = await htmlRes.text();',
        "  const vendorRes = await fetch(base + '/vendor/marked.min.js');",
        '  const vendorB64 = Buffer.from(await vendorRes.arrayBuffer()).toString(' + JSON.stringify('base64') + ');',
        '  console.log(' + JSON.stringify('RESULT ') + ' + JSON.stringify({ htmlStatus: htmlRes.status, html, vendorStatus: vendorRes.status, vendorB64 }));',
        '  server.closeAllConnections();',
        '  await new Promise((resolve) => server.close(resolve));',
'})().catch((e) => { console.error(' + JSON.stringify('PROBE-FAIL ') + ' + (e && e.message)); process.exitCode = 1; });',
    ].join(nl);
}

interface ProbeResult { htmlStatus: number; html: string; vendorStatus: number; vendorB64: string; }

function runProbe(esm: boolean, uiPath: string | null, cwd: string, env: NodeJS.ProcessEnv): ProbeResult {
    const args = esm ? ['--input-type=module', '-e', probe(esm, uiPath)] : ['-e', probe(esm, uiPath)];
    const run = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env });
    assert.equal(run.status, 0, `probe failed: ${run.stderr || run.stdout}`);
    const marker = run.stdout.split(nl).find((line) => line.startsWith('RESULT '));
    assert.ok(marker, `probe printed no result: ${run.stdout} ${run.stderr}`);
    return JSON.parse(marker.slice('RESULT '.length)) as ProbeResult;
}

describe('built package UI serving (native JS, real HubManager)', () => {
    let fakeCwd: string;
    let env: NodeJS.ProcessEnv;
    let customDir: string;

    before(() => {
        buildFromSources();
        fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-ui-cwd-'));
        fs.mkdirSync(path.join(fakeCwd, 'ui'), { recursive: true });
        fs.writeFileSync(path.join(fakeCwd, 'ui', 'index.html'), '<html>FAKE-CWD-UI</html>');
        fs.mkdirSync(path.join(fakeCwd, 'root'), { recursive: true });
        customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-ui-custom-'));
        fs.writeFileSync(path.join(customDir, 'index.html'), '<html>CUSTOM-UI-HTML</html>');
        fs.mkdirSync(path.join(customDir, 'vendor'), { recursive: true });
        fs.writeFileSync(path.join(customDir, 'vendor', 'marked.min.js'), '// custom vendor bytes');
        env = { ...process.env,
            PROBE_ROOT: path.join(fakeCwd, 'root'),
            PROBE_CONFIG: path.join(fakeCwd, 'config.json'),
        };
    });

    const cases: Array<{ name: string; esm: boolean; custom: boolean }> = [
        { name: 'CJS: bundled HTML and vendor bytes from unrelated cwd', esm: false, custom: false },
        { name: 'ESM: bundled HTML and vendor bytes from unrelated cwd', esm: true, custom: false },
        { name: 'CJS: explicit uiPath overrides HTML and vendor', esm: false, custom: true },
        { name: 'ESM: explicit uiPath overrides HTML and vendor', esm: true, custom: true },
    ];

    for (const c of cases) {
        it(c.name, () => {
            const uiPath = c.custom ? path.join(customDir, 'index.html') : null;
            const run = runProbe(c.esm, uiPath, fakeCwd, env);
            assert.equal(run.htmlStatus, 200);
            assert.equal(run.vendorStatus, 200);
            if (uiPath == null) {
                const raw = fs.readFileSync(path.join(repoRoot, 'ui', 'index.html'), 'utf8');
                assert.equal(run.html, raw.split('__APP_VERSION__').join(pkgVersion));
                assert.deepEqual(Buffer.from(run.vendorB64, 'base64'), fs.readFileSync(path.join(repoRoot, 'ui', 'vendor', 'marked.min.js')));
            } else {
                assert.equal(run.html, '<html>CUSTOM-UI-HTML</html>');
                assert.deepEqual(Buffer.from(run.vendorB64, 'base64'), Buffer.from('// custom vendor bytes'));
            }
        });
    }
});
