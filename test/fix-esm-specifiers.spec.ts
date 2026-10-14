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
