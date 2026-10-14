'use strict';

// Post-build step for the native ESM output: tsc preserves extensionless
// relative specifiers, which Node ESM cannot resolve. Uses the TypeScript
// compiler API so only real module specifiers change - string literals,
// comments and already-extensioned specifiers are left untouched.

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
    if (edits.length === 0) return { text: sourceText, changed: false };
    let text = sourceText;
    const ordered = edits.slice().sort(function (a, b) { return b.start - a.start; });
    for (const edit of ordered) {
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    return { text: text, changed: true };
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
