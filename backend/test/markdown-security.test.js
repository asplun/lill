import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { renderMD } from '../lib/utils.js';

test('Markdown keeps empty input empty and escapes raw HTML', () => {
  assert.equal(renderMD(null), '');
  assert.equal(renderMD(''), '');
  assert.equal(renderMD('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('Markdown literal ampersands are escaped once', () => {
  assert.equal(renderMD('A & B &quot;'), '<p>A &amp; B &amp;quot;</p>');
});

test('image labels escape quotes rather than adding attributes', () => {
  assert.equal(renderMD('![x" onerror="alert(1)](missing)'),
    '<p><img src="missing" alt="x&quot; onerror=&quot;alert(1)" loading="lazy"></p>');
});

test('unsafe link and image destinations become inert text', () => {
  for (const prefix of ['', '!']) {
    for (const destination of ['javascript:alert(1)', 'data:text/html,x', 'java\tscript:x', 'javascript&#58;x']) {
      assert.equal(renderMD(`${prefix}[text](${destination})`), '<p>text</p>');
    }
  }
});

test('inline code does not generate images or links', () => {
  assert.equal(renderMD('`![x](missing) [link](javascript:alert(1))`'),
    '<p><code>![x](missing) [link](javascript:alert(1))</code></p>');
});

test('actual more markers are removed from rendered body rather than displayed', () => {
  assert.equal(renderMD('before<!--more-->after'), '<p>beforeafter</p>');
  assert.equal(renderMD('before\n\n<!-- MORE -->\n\nafter'), '<p>before</p>\n<p>after</p>');
  assert.equal(renderMD('&lt;!--more--&gt;'), '<p>&amp;lt;!--more--&amp;gt;</p>');
});

test('more marker examples remain literal inside inline code and fences', () => {
  assert.equal(renderMD('`<!--more-->`'), '<p><code>&lt;!--more--&gt;</code></p>');
  assert.equal(renderMD('`` ` <!--more--> ``'), '<p><code> ` &lt;!--more--&gt; </code></p>');
  for (const language of ['', 'html', 'c++']) {
    assert.equal(renderMD('```' + language + '\n<!--more-->\n```'),
      '<pre><code class="language-' + (language || 'text') + '">&lt;!--more--&gt;</code></pre>');
  }
  for (const markdown of ['~~~html\n<!--more-->\n~~~', '```html\n<!--more-->']) {
    assert.equal(renderMD(markdown), '<pre><code class="language-html">&lt;!--more--&gt;</code></pre>');
  }
});

// Exercise the actual preview function without booting the admin UI or its server.
const adminSource = await readFile(new URL('../../frontend/public/admin/app.js', import.meta.url), 'utf8');
const previewSource = adminSource.match(/^function mdToHtml\(md\) \{[\s\S]*?^\}/m)?.[0];
const escapeSource = adminSource.match(/^function escape\(s\) \{.*\}$/m)?.[0];
assert.ok(previewSource, 'the real mdToHtml function must be extracted');
assert.ok(escapeSource, 'the existing preview escape helper must be extracted');

// Same opt-in browser dependency convention as admin-ui.test.js; no project dependency.
for (const renderer of ['backend', 'preview']) {
  test(`real ${renderer} Markdown HTML remains safe when parsed by Chrome`, {
    skip: !process.env.LILL_UI_PLAYWRIGHT,
  }, async t => {
    const { chromium } = await import(process.env.LILL_UI_PLAYWRIGHT);
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.LILL_UI_CHROME ? { executablePath: process.env.LILL_UI_CHROME } : {}),
    });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent('<!doctype html><head><base href="https://markdown.test/"></head><body></body>');
    page.on('dialog', dialog => dialog.dismiss());
    const evidence = [];
    t.after(async () => {
      if (process.env.LILL_MARKDOWN_EVIDENCE) {
        const destination = process.env.LILL_MARKDOWN_EVIDENCE;
        await writeFile(renderer === 'backend' ? destination : destination.replace(/\.json$/, '') + '-preview.json',
          JSON.stringify(evidence, null, 2));
      }
    });

    async function inspect(markdown) {
      const html = renderer === 'backend' ? renderMD(markdown) : await page.evaluate(({ markdown, source }) => {
        const renderPreview = new Function(source + '\nreturn mdToHtml;')();
        return renderPreview(markdown);
      }, { markdown, source: escapeSource + '\n' + previewSource });
      const dom = await page.evaluate(output => {
        window.__markdownXss = 0;
        const root = document.createElement('main');
        root.innerHTML = output;
        document.body.replaceChildren(root);
        // Deterministic real event dispatch; lazy image loading does not hide onerror.
        for (const image of root.querySelectorAll('img')) image.dispatchEvent(new Event('error'));
        const elements = [...root.querySelectorAll('*')];
        const attrs = element => Object.fromEntries([...element.attributes].map(attr => [attr.name, attr.value]));
        return {
          xss: window.__markdownXss,
          eventAttributes: elements.flatMap(el => [...el.attributes]
            .filter(attr => /^on/i.test(attr.name)).map(attr => [el.tagName, attr.name, attr.value])),
          executableElements: root.querySelectorAll('script,iframe,object,embed,svg,math,style').length,
          links: [...root.querySelectorAll('a')].map(el => ({
            ...attrs(el), resolvedProtocol: el.protocol, text: el.textContent,
          })),
          images: [...root.querySelectorAll('img')].map(attrs),
          code: [...root.querySelectorAll('code')].map(el => el.textContent),
          tags: elements.map(el => el.tagName.toLowerCase()),
          text: root.textContent,
        };
      }, html);
      evidence.push({ renderer, markdown, html, dom });
      return dom;
    }

    function assertInert(dom) {
      assert.equal(dom.xss, 0, 'an injected event handler executed');
      assert.deepEqual(dom.eventAttributes, [], 'HTML acquired event-handler attributes');
      assert.equal(dom.executableElements, 0, 'HTML acquired an executable element');
      for (const link of dom.links) {
        assert.ok(['http:', 'https:', 'mailto:'].includes(link.resolvedProtocol), JSON.stringify(link));
        assert.deepEqual(Object.keys(link).sort(), ['href', 'rel', 'resolvedProtocol', 'target', 'text', ...('title' in link ? ['title'] : [])].sort());
      }
      for (const image of dom.images) {
        assert.deepEqual(Object.keys(image).sort(), ['alt', 'loading', 'src', ...('title' in image ? ['title'] : [])].sort());
      }
    }

    for (const [name, markdown] of [
      ['image alt quote injection', '![x" onerror="window.__markdownXss=1](missing)'],
      ['reported image payload', '![x" onerror="alert(1)](missing)'],
      ['source quote injection', '![x](missing" onerror="window.__markdownXss=1)'],
      ['href quote injection', '[x](https://example.test/" onmouseover="window.__markdownXss=1)'],
      ['entity-shaped quotes remain data', '![&quot; onerror=&quot;alert(1)](/image.png)'],
      ['nested Markdown in image alt cannot become an anchor attribute', '![[jump](javascript:alert(1)) " onerror="window.__markdownXss=1](/image.png)'],
      ['emphasis inside attributes stays text', '![**bold** " onerror="window.__markdownXss=1](/image.png)'],
    ]) {
      await t.test(name, async () => assertInert(await inspect(markdown)));
    }

    const unsafeUrls = [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:msgbox(1)',
      'data:text/html,<svg/onload=alert(1)>', 'file:///etc/passwd', 'blob:https://example.test/id',
      'java\tscript:alert(1)', 'java\nscript:alert(1)', '\u0000javascript:alert(1)',
      'javascript&#58;alert(1)', '&#106;avascript:alert(1)', 'jav&#x61;script:alert(1)',
      'javascript&colon;alert(1)', 'java&Tab;script:alert(1)', 'java&NewLine;script:alert(1)',
      'https://example.test/\rpath', 'https://example.test/%0apath', '/uploads/%00image.png',
      '//outside.example.test/path', '\\\\outside.example.test/path',
    ];
    for (const url of unsafeUrls) {
      for (const image of [false, true]) {
        await t.test(`${image ? 'image' : 'link'} rejects unsafe URL ${JSON.stringify(url)}`, async () => {
          const dom = await inspect(`${image ? '!' : ''}[text](${url})`);
          assertInert(dom);
          assert.equal(dom.links.length, 0, 'unsafe destination produced a link');
          assert.equal(dom.images.length, 0, 'unsafe destination produced an image');
        });
      }
    }

    for (const url of [
      'http://example.test/post', 'https://example.test/a?x=1&y=2',
      '/post/entry', './intro', '../posts/one', 'posts/one', '?page=2&sort=asc', '#part',
      '/uploads/中文.png', 'https://example.test/article_(details)',
      'https://example.test/one_(two_(three))', 'https://example.test/?q="quoted"',
    ]) {
      for (const image of [false, true]) {
        await t.test(`${image ? 'image' : 'link'} preserves safe URL ${url}`, async () => {
          const dom = await inspect(`${image ? '!' : ''}[text](${url})`);
          assertInert(dom);
          assert.equal(image ? dom.images.length : dom.links.length, 1);
          assert.equal(image ? dom.images[0].src : dom.links[0].href, url);
        });
      }
    }

    await t.test('mailto remains available for links', async () => {
      const dom = await inspect('[mail](mailto:reader@example.test?subject=Hello&body=World)');
      assertInert(dom);
      assert.equal(dom.links[0].href, 'mailto:reader@example.test?subject=Hello&body=World');
    });

    await t.test('mailto is not an image source', async () => {
      const dom = await inspect('![mail](mailto:reader@example.test)');
      assertInert(dom);
      assert.equal(dom.images.length, 0);
    });

    await t.test('alt and title use literal attribute data, including quotes and entities', async () => {
      const dom = await inspect('![A "quote" \'single\' & &quot;](/image.png "A \\"title\\" & &quot;")');
      assertInert(dom);
      assert.equal(dom.images.length, 1);
      assert.equal(dom.images[0].alt, 'A "quote" \'single\' & &quot;');
      assert.equal(dom.images[0].title, 'A "title" & &quot;');
      assert.equal(dom.images[0].src, '/image.png');
    });

    await t.test('link title is escaped without becoming another attribute', async () => {
      const dom = await inspect('[**label**](https://example.test/ "title \\" onmouseover=\\"alert(1)")');
      assertInert(dom);
      assert.equal(dom.links.length, 1);
      assert.equal(dom.links[0].title, 'title " onmouseover="alert(1)');
      assert.ok(dom.tags.includes('strong'));
    });

    await t.test('quoted titles can contain parentheses', async () => {
      const dom = await inspect('[label](/post/a "A (nested) title")');
      assertInert(dom);
      assert.equal(dom.links[0].href, '/post/a');
      assert.equal(dom.links[0].title, 'A (nested) title');
    });

    await t.test('single-quoted titles and HTML-shaped alt remain attribute text', async () => {
      const dom = await inspect('![<svg/onload=alert(1)>](/image.png \'A "quote" & <b>title</b>\')');
      assertInert(dom);
      assert.equal(dom.images[0].alt, '<svg/onload=alert(1)>');
      assert.equal(dom.images[0].title, 'A "quote" & <b>title</b>');
    });

    await t.test('escaped URL parentheses preserve their literal destination', async () => {
      const dom = await inspect('[label](https://example.test/a\\(b\\))');
      assertInert(dom);
      assert.equal(dom.links[0].href, 'https://example.test/a(b)');
    });

    await t.test('image alt containing link syntax stays literal', async () => {
      const dom = await inspect('![use [docs](https://example.test)](/image.png)');
      assertInert(dom);
      assert.equal(dom.links.length, 0);
      assert.equal(dom.images.length, 1);
      assert.equal(dom.images[0].alt, 'use [docs](https://example.test)');
    });

    await t.test('an image can be a link label without recursive attribute conversion', async () => {
      const dom = await inspect('[![badge](/badge.png)](https://example.test/)');
      assertInert(dom);
      assert.equal(dom.links[0].href, 'https://example.test/');
      assert.equal(dom.images[0].src, '/badge.png');
    });

    for (const [name, markdown, code] of [
      ['single-backtick code', '`![x" onerror="window.__markdownXss=1](missing) **literal**`', '![x" onerror="window.__markdownXss=1](missing) **literal**'],
      ['double-backtick code', '`` ` [x](javascript:alert(1)) ``', ' ` [x](javascript:alert(1)) '],
      ['fenced code', '```js\n![x" onerror="window.__markdownXss=1](missing)\n[x](javascript:alert(1))\n```', '![x" onerror="window.__markdownXss=1](missing)\n[x](javascript:alert(1))'],
      ['tilde-fenced marker example', '~~~html\n<!--more-->\n~~~', '<!--more-->'],
      ['long fence containing a shorter fence', '````md\n```\n<!--more-->\n```\n````', '```\n<!--more-->\n```'],
      ['unclosed fence while editing', '```html\n<!--more-->', '<!--more-->'],
    ]) {
      await t.test(`${name} is never reparsed as Markdown`, async () => {
        const dom = await inspect(markdown);
        assertInert(dom);
        assert.equal(dom.links.length, 0);
        assert.equal(dom.images.length, 0);
        assert.deepEqual(dom.code, [code]);
      });
    }

    await t.test('inline code inside alt cannot restore HTML into an attribute', async () => {
      const dom = await inspect('![`x" onerror="window.__markdownXss=1`](/image.png)');
      assertInert(dom);
      assert.equal(dom.images.length, 1);
      assert.equal(dom.images[0].alt, 'x" onerror="window.__markdownXss=1');
    });

    await t.test('code containing HTML is displayed as literal text', async () => {
      const dom = await inspect('`<img src=x onerror=alert(1)> &quot;`');
      assertInert(dom);
      assert.deepEqual(dom.code, ['<img src=x onerror=alert(1)> &quot;']);
    });

    await t.test('fence language info cannot inject attributes or HTML', async () => {
      const dom = await inspect('```js" onmouseover="window.__markdownXss=1\n<!--more-->\n```');
      assertInert(dom);
      assert.deepEqual(dom.code, ['<!--more-->']);
      assert.equal(dom.tags.filter(tag => tag === 'pre').length, 1);
    });

    await t.test('legacy code placeholders in input cannot restore generated HTML', async () => {
      const dom = await inspect('\u0000CODE0\u0000\n\n`<script>alert(1)</script>`');
      assertInert(dom);
      assert.deepEqual(dom.code, ['<script>alert(1)</script>']);
    });

    await t.test('more markers disappear only outside code examples', async () => {
      const dom = await inspect('before<!--more-->after\n\n`<!--more-->`\n\n```c++\n<!--more-->\n```');
      assertInert(dom);
      assert.deepEqual(dom.code, ['<!--more-->', '<!--more-->']);
      assert.equal(dom.text.match(/<!--more-->/g).length, 2);
      assert.match(dom.text, /beforeafter/);
    });

    await t.test('common block and inline Markdown still renders', async () => {
      const dom = await inspect([
        '# Heading "quoted"', '', '**bold** *italic* ~~deleted~~', '', '> quoted', '',
        '- first', '- second', '', '1. one', '2. two', '', '---', '',
        '| A | B |', '| --- | --- |', '| one | two |', '',
      ].join('\n'));
      assertInert(dom);
      for (const tag of ['h1', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'hr', 'table', 'th', 'td']) {
        assert.ok(dom.tags.includes(tag), `missing ${tag}`);
      }
      assert.match(dom.text, /Heading "quoted"/);
    });

    if (renderer === 'preview') {
      await t.test('legacy star lists and star horizontal rules still render', async () => {
        const dom = await inspect('* first\n* second\n\n***');
        assertInert(dom);
        assert.ok(dom.tags.includes('ul'));
        assert.equal(dom.tags.filter(tag => tag === 'li').length, 2);
        assert.ok(dom.tags.includes('hr'));
      });

      await t.test('empty preview retains its UI placeholder', async () => {
        const dom = await inspect('');
        assertInert(dom);
        assert.equal(dom.text, '预览会显示在这里');
      });
    }
  });
}
