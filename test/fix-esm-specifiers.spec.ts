import assert from 'node:assert/strict';

const fixer = require("../scripts/fix-esm-specifiers.js") as {
    rewriteSource: (sourceText: string, fileName?: string) => { text: string; changed: boolean };
};

const nl = String.fromCharCode(10);
const sq = String.fromCharCode(39);

describe('fix-esm-specifiers rewrite rules', () => {
    const input = [
        "import { a } from './dep';",
        "export { b } from '../dir/dep2';",
        "export * from './star';",
        "export * as ns from './ns';",
        "const dyn = () => import('./dynamic');",
        "import pkg from 'external-pkg';",
        "import data from './data.json';",
        'const s = "from ' + sq + './nope' + sq + '";',
        '// from ' + sq + './comment-nope' + sq + ';',
        'const u = "import ' + sq + './tpl-nope' + sq + '";',
        'export { local };',
    ].join(nl);

    const expected = [
        "import { a } from './dep.js';",
        "export { b } from '../dir/dep2.js';",
        "export * from './star.js';",
        "export * as ns from './ns.js';",
        "const dyn = () => import('./dynamic.js');",
        "import pkg from 'external-pkg';",
        "import data from './data.json';",
        'const s = "from ' + sq + './nope' + sq + '";',
        '// from ' + sq + './comment-nope' + sq + ';',
        'const u = "import ' + sq + './tpl-nope' + sq + '";',
        'export { local };',
    ].join(nl);

    it('rewrites only relative extensionless module specifiers', () => {
        const once = fixer.rewriteSource(input);
        assert.equal(once.changed, true);
        assert.equal(once.text, expected);
    });

    it('is idempotent on already-rewritten output', () => {
        const once = fixer.rewriteSource(input);
        const twice = fixer.rewriteSource(once.text);
        assert.equal(twice.changed, false);
        assert.equal(twice.text, once.text);
    });
});

describe('fix-esm-specifiers ESM metadata injection', () => {
    it('injects native ESM metadata only for referenced CJS globals', () => {
        const input = [
            'const pkg = require(' + sq + './data' + sq + ');',
            'export const dir = __dirname;',
            'export const file = __filename;',
        ].join(nl);
        const once = fixer.rewriteSource(input);
        assert.equal(once.changed, true);
        const lines = once.text.split(nl);
        assert.equal(lines[0], 'import { fileURLToPath as __vhFileURLToPath } from ' + sq + 'node:url' + sq + ';');
        assert.equal(lines[1], 'import { createRequire as __vhCreateRequire } from ' + sq + 'node:module' + sq + ';');
        assert.equal(lines[2], 'const __filename = __vhFileURLToPath(import.meta.url);');
        assert.equal(lines[3], 'const __dirname = __vhFileURLToPath(new URL(' + sq + '.' + sq + ', import.meta.url));');
        assert.equal(lines[4], 'const require = __vhCreateRequire(import.meta.url);');
        assert.ok(once.text.includes('require(' + sq + './data' + sq + ')'));
        const twice = fixer.rewriteSource(once.text);
        assert.equal(twice.changed, false);
        assert.equal(twice.text, once.text);
    });

    it('keeps the shebang first and ignores property-name lookalikes', () => {
        const input = [
            '#!/usr/bin/env node',
            'const v = require(' + sq + './pkg' + sq + ').version;',
            'export const fake = obj.__dirname;',
        ].join(nl);
        const once = fixer.rewriteSource(input);
        assert.equal(once.changed, true);
        const lines = once.text.split(nl);
        assert.equal(lines[0], '#!/usr/bin/env node');
        assert.equal(lines[1], 'import { createRequire as __vhCreateRequire } from ' + sq + 'node:module' + sq + ';');
        assert.equal(lines[2], 'const require = __vhCreateRequire(import.meta.url);');
        assert.ok(!once.text.includes('__vhFileURLToPath'));
        assert.ok(once.text.includes('require(' + sq + './pkg' + sq + ')'));
    });
});
