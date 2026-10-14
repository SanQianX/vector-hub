'use strict';

// Post-build step for the native ESM output: tsc preserves extensionless
// relative specifiers, which Node ESM cannot resolve, and CJS metadata
// (__dirname/__filename/require) that has no native ESM equivalent. Uses the
// TypeScript compiler API so only real module syntax changes - string
// literals, comments and already-extensioned specifiers are left untouched.
// Each file gets only the native ESM metadata it actually references,
// injected after the shebang line.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const esmRoot = path.resolve(__dirname, '..', 'dist', 'esm');
const nl = String.fromCharCode(10);

function isRelativeSpecifier(spec) {
    return spec.startsWith('./') || spec.startsWith('../');
}

function rewriteSource(sourceText, fileName) {
    const name = fileName || 'module.js';
    const sourceFile = ts.createSourceFile(name, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const edits = [];
    function collect(literal) {
        const spec = literal.text;
        if (!isRelativeSpecifier(spec)) return;
        if (path.extname(spec) !== '') return;
        const start = literal.getStart(sourceFile);
        const end = literal.getEnd();
        const quote = sourceText[start];
        edits.push({ start: start, end: end, text: quote + spec + '.js' + quote });
    }
    function visit(node) {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            collect(node.moduleSpecifier);
        } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            collect(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    let text = sourceText;
    const ordered = edits.slice().sort(function (a, b) { return b.start - a.start; });
    for (const edit of ordered) {
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    const meta = detectNodeMetaUsage(sourceFile);
    const alreadyInjected = sourceText.indexOf('__vhFileURLToPath') !== -1 || sourceText.indexOf('__vhCreateRequire') !== -1;
    const needsHeader = (meta.dirname || meta.filename || meta.require) && !alreadyInjected;
    if (needsHeader) {
        text = injectEsmMetaHeader(text, meta);
    }
    return { text: text, changed: edits.length > 0 || needsHeader };
}

function detectNodeMetaUsage(sourceFile) {
    const usage = { dirname: false, filename: false, require: false };
    function visit(node) {
        if (ts.isIdentifier(node)) {
            const parent = node.parent;
            const isPropertyRef = parent != null && ts.isPropertyAccessExpression(parent) && parent.name === node;
            if (!isPropertyRef) {
                if (node.text === '__dirname') usage.dirname = true;
                else if (node.text === '__filename') usage.filename = true;
            }
        } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
            usage.require = true;
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return usage;
}

function injectEsmMetaHeader(text, usage) {
    const header = [];
    if (usage.dirname || usage.filename) {
        header.push("import { fileURLToPath as __vhFileURLToPath } from 'node:url';");
    }
    if (usage.require) {
        header.push("import { createRequire as __vhCreateRequire } from 'node:module';");
    }
    if (usage.filename) {
        header.push('const __filename = __vhFileURLToPath(import.meta.url);');
    }
    if (usage.dirname) {
        header.push("const __dirname = __vhFileURLToPath(new URL('.', import.meta.url));");
    }
    if (usage.require) {
        header.push('const require = __vhCreateRequire(import.meta.url);');
    }
    header.push('');
    const lines = text.split(nl);
    const insertAt = lines.length > 0 && lines[0].startsWith('#!') ? 1 : 0;
    return lines.slice(0, insertAt).concat(header, lines.slice(insertAt)).join(nl);
}

function listJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push.apply(out, listJsFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function main() {
    let touched = 0;
    for (const file of listJsFiles(esmRoot)) {
        const original = fs.readFileSync(file, 'utf8');
        const updated = rewriteSource(original, path.basename(file));
        if (updated.changed) {
            fs.writeFileSync(file, updated.text);
            touched++;
        }
    }
    fs.writeFileSync(path.join(esmRoot, 'package.json'), JSON.stringify({ type: 'module' }) + nl);
    console.log('fix-esm-specifiers: rewrote ' + touched + ' file(s) in dist/esm');
}

module.exports = { rewriteSource: rewriteSource, listJsFiles: listJsFiles };

if (require.main === module) main();
