import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MessageBody, safeMarkdownUrl } from '../src/renderer/src/components/MessageBody'

vi.mock('../src/renderer/src/api', () => ({ openExternal: vi.fn() }))
const render = (text: string, markdown = true) => renderToStaticMarkup(createElement(MessageBody, { text, markdown }))

describe('Markdown message presentation', () => {
  it('renders headings, emphasis, strikethrough, quotes, rules and hard breaks', () => {
    const html = render('# Heading\n\n**bold** *italic* ~~gone~~\n\n> quote\n\n---\n\nline  \nbreak')
    for (const fragment of ['<h1>Heading</h1>', '<strong>bold</strong>', '<em>italic</em>', '<del>gone</del>', '<blockquote>', '<hr', '<br']) expect(html).toContain(fragment)
  })
  it('renders GFM tables and nested ordered/unordered lists', () => {
    const html = render('| A | B |\n| - | - |\n| one | two |\n\n1. first\n   - nested\n2. second')
    for (const fragment of ['<table>', '<th>A</th>', '<td>two</td>', '<ol>', '<ul>', '<li>nested</li>']) expect(html).toContain(fragment)
    expect(html).toContain('markdown-table')
  })
  it('keeps inline code distinct from multiple labelled copyable blocks', () => {
    const html = render('Use `x`\n\n```python\n  print("x")\n```\n\n```js\nconst y = 1\n```')
    expect(html).toContain('<code>x</code>')
    expect(html).toContain('python')
    expect(html).toContain('js')
    expect(html).toContain('  print(&quot;x&quot;)\n')
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html.match(/<pre>/g)).toHaveLength(2)
  })
  it('renders each incomplete streaming prefix without throwing or changing the source', () => {
    const text = 'Hello **world**\n\n```python\n  print("hello")\n```\n\n[link](https://example.com)'
    for (let i = 0; i <= text.length; i++) expect(() => render(text.slice(0, i))).not.toThrow()
    const incomplete = render('```python\n  print("hello")')
    expect(incomplete).toContain('<pre><code>  print(&quot;hello&quot;)')
    expect(text).toContain('```python')
  })
  it('displays the original syntax literally when disabled, and can render the same text formatted', () => {
    const text = '# Heading\n**bold**\n```js\nalert(1)\n```\n<script>alert(1)</script>'
    const literal = render(text, false)
    expect(literal).toContain('# Heading\n**bold**\n```js')
    expect(literal).toContain('&lt;script&gt;')
    expect(literal).not.toContain('<h1>')
    expect(render(text)).toContain('<h1>Heading</h1>')
  })
  it('does not render arbitrary HTML or fetch Markdown images', () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://tracker.test" onerror="alert(1)">\n\n![alt text](https://tracker.test/pixel)\n\n![local](file:///secret)')
    expect(html).not.toMatch(/<(script|img|iframe)/)
    expect(html).not.toContain('tracker.test')
    expect(html).toContain('[alt text]')
  })
  it('only renders explicit HTTP(S) links as anchors', () => {
    expect(render('[web](https://example.com/path?q=1)')).toContain('href="https://example.com/path?q=1"')
    for (const url of ['javascript:alert', 'file:///etc/passwd', 'hfimg://images/test', 'data:text/html,test', '//example.com', '/relative', '#fragment', 'mailto:a@b.com']) {
      expect(safeMarkdownUrl(url)).toBe('')
      expect(render(`[unsafe](${url})`)).not.toContain('<a ')
    }
    expect(safeMarkdownUrl('https://user:password@example.com')).toBe('')
    expect(safeMarkdownUrl('https://exa\nmple.com')).toBe('')
    expect(safeMarkdownUrl('https://')).toBe('')
  })
})
