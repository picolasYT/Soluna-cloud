import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/web/client/markdown.js';

test('AI lists share one list block with compact paragraphs and nested items', () => {
  const html = renderMarkdown('- CPU\n\n- Memoria\n\n- Sonido');
  assert.equal((html.match(/<ul>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(renderMarkdown('3. Uno\n4. Dos'), /<ol start="3"><li><p>Uno<\/p><\/li><li><p>Dos/);
  assert.match(renderMarkdown('- Principal\n  - Hijo\n  - Otro\n- Final'), /<ul><li><p>Principal<\/p>\n<ul>/);
  assert.match(renderMarkdown('Texto\n\n---\n\n## Título'), /<hr>\n<h2>Título<\/h2>/);
});

test('streamed and finished code preserves Markdown and HTML literally', () => {
  const code = '<h1>**Hola**</h1>\n- no es una lista\n# no es un título';
  for (const end of ['', '\n```']) {
    const html = renderMarkdown('```html\n' + code + end);
    assert.match(html, /<pre><code data-lang="html">&lt;h1&gt;\*\*Hola\*\*&lt;\/h1&gt;/);
    assert.ok(!html.includes('<ul>'));
    assert.ok(!html.includes('<strong>'));
  }
  assert.equal(renderMarkdown('`**literal**`'), '<p><code>**literal**</code></p>');
});

test('Markdown cannot inject HTML, link attributes or executable URL schemes', () => {
  assert.ok(!renderMarkdown('<img src=x onerror=alert(1)>').includes('<img'));
  assert.ok(!renderMarkdown('[Abrir](javascript:alert(1))').includes('href='));
  const safe = renderMarkdown('[Web](https://example.com/"onclick="alert)');
  assert.match(safe, /&quot;onclick=&quot;/);
  assert.ok(!safe.includes('"onclick="'));
  assert.match(renderMarkdown('> **Cita**'), /<blockquote><p><strong>Cita<\/strong>/);
});
