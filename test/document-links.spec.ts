import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

describe('knowledge document link contract', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../ui/index.html'), 'utf8');
    const functions = ['isRelativeKnowledgeLink', 'resolveDocumentLink'].map(name => {
        const matched = html.match(new RegExp(`  function ${name}\\([^]*?^  }`, 'm'));
        assert.ok(matched, name); return matched[0];
    }).join('\n');
    const links = vm.runInNewContext(functions + '\n({isRelativeKnowledgeLink,resolveDocumentLink})', { URL });
    it('preserves relative markdown links without admitting executable protocols or absolute URLs', () => {
        for (const href of ['../changes/a.md', './知识%20目录/a.md', 'a.md#section']) assert.ok(links.isRelativeKnowledgeLink(href));
        for (const href of ['javascript:alert(1)', 'javascript:evil.md', 'data:text/html,a.md', '//evil.test/a.md', 'C:\\private.md', '/private.md', 'a.html', '\\evil.md', 'a.md?key=x']) assert.equal(links.isRelativeKnowledgeLink(href), false, href);
    });
    it('resolves Unicode/space paths correctly on Windows and POSIX', () => {
        assert.equal(links.resolveDocumentLink('D:\\中文 项目\\modules\\live.md', '../changes/a.md'), 'D:\\中文 项目\\changes\\a.md');
        assert.equal(links.resolveDocumentLink('/home/中文 项目/modules/live.md', '../changes/a.md'), '/home/中文 项目/changes/a.md');
        assert.equal(links.resolveDocumentLink('D:\\项目 #1\\modules\\live.md', '../changes/a.md'), 'D:\\项目 #1\\changes\\a.md');
        assert.throws(() => links.resolveDocumentLink('/knowledge/a.md', 'javascript:evil.md'));
    });
});
