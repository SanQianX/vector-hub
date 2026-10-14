import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Guards the published dual output: dist/esm must be importable by native
 * Node ESM through the package exports map, no loader. The probe runs in a
 * spawned node because ts-mocha transpiles dynamic import() into require().
 */

const repoRoot = path.resolve(__dirname, '..');
const esmRoot = path.join(repoRoot, 'dist', 'esm');
const requiredExports = [
    'VectorHub',
    'createMiniMaxEmbeddings',
    'createOpenAIEmbeddings',
    'HubManager',
    'createServer',
    'pickFolder',
    'warmFolderPicker',
    'pingFolderPicker',
];

function runNpm(args: string[]) {
    const npmCli = process.env.npm_execpath;
    if (npmCli) {
        return spawnSync(process.execPath, [npmCli, ...args], { cwd: repoRoot, encoding: 'utf8' });
    }
    return spawnSync('npm', args, { cwd: repoRoot, shell: true, encoding: 'utf8' });
}

// Always rebuild from current sources: a stale dist must never mask a
// broken build pipeline.
function buildFromSources(): void {
    const run = runNpm(['run', 'build']);
    assert.equal(run.status, 0, `npm run build failed: ${run.stderr || run.stdout}`);
}

function listJsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listJsFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function relativeSpecifiers(line: string): string[] {
    const specs: string[] = [];
    for (const marker of ["from '", 'from "', "import '", 'import "']) {
        let idx = line.indexOf(marker);
        while (idx !== -1) {
            const quote = marker[marker.length - 1];
            const start = idx + marker.length;
            const end = line.indexOf(quote, start);
            if (end !== -1) {
                const spec = line.slice(start, end);
                if (spec.startsWith('./') || spec.startsWith('../')) specs.push(spec);
            }
            idx = line.indexOf(marker, end === -1 ? start : end + 1);
        }
    }
    return specs;
}

describe('built package entry (dist + exports map)', () => {
    before(buildFromSources);

    it('emits ESM relative specifiers with explicit .js extensions', () => {
        const offenders: string[] = [];
        for (const file of listJsFiles(esmRoot)) {
            const lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10));
            for (const line of lines) {
                for (const spec of relativeSpecifiers(line)) {
                    if (!spec.endsWith('.js')) offenders.push(`${path.relative(repoRoot, file)} -> ${spec}`);
                }
            }
        }
        assert.deepEqual(offenders, [], 'dist/esm contains relative specifiers without .js (breaks native Node ESM import)');
    });

    it('imports the ESM entry through the exports map under native Node ESM', () => {
        const probe = `
const need = ${JSON.stringify(requiredExports)};
const mod = await import('@sanqianx/vector-hub');
for (const key of need) {
    if (!(key in mod)) { console.error('missing export: ' + key); process.exit(2); }
}
console.log('esm-import-ok');
`;
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: repoRoot, encoding: 'utf8' });
        assert.equal(run.status, 0, `native ESM import of @sanqianx/vector-hub failed: ${run.stderr || run.stdout}`);
        assert.match(run.stdout, /esm-import-ok/);
    });

    it('requires the CJS entry through the exports map', () => {
        const probe = `
const need = ${JSON.stringify(requiredExports)};
const mod = require('@sanqianx/vector-hub');
for (const key of need) {
    if (!(key in mod)) { console.error('missing export: ' + key); process.exit(2); }
}
console.log('cjs-import-ok');
`;
        const run = spawnSync(process.execPath, ['-e', probe], { cwd: repoRoot, encoding: 'utf8' });
        assert.equal(run.status, 0, `CJS require of @sanqianx/vector-hub failed: ${run.stderr || run.stdout}`);
        assert.match(run.stdout, /cjs-import-ok/);
    });
});
