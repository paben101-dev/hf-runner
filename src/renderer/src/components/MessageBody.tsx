import { memo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L, type Lang } from '@shared/i18n'
import { openExternal } from '../api'

/** Only explicit web links may leave the renderer; relative and app/file URLs stay inert. */
export function safeMarkdownUrl(url: string): string {
  if (!/^https?:\/\//i.test(url) || /[\u0000-\u0020]/.test(url)) return ''
  try {
    const parsed = new URL(url)
    return parsed.hostname && !parsed.username && !parsed.password ? url : ''
  } catch { return '' }
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copyResult, setCopyResult] = useState<{ code: string; ok: boolean } | null>(null)
  const copyState = copyResult?.code === code ? (copyResult.ok ? 'copied' : 'failed') : 'idle'
  const copy = async () => {
    // mdast-to-hast adds one display newline to code blocks; do not copy that synthetic newline.
    try { await navigator.clipboard.writeText(code.replace(/\n$/, '')); setCopyResult({ code, ok: true }) }
    catch { setCopyResult({ code, ok: false }) }
  }
  return <div className="markdown-code-block">
    <div className="markdown-code-head">
      <span className="muted small">{language || L('コード', 'Code')}</span>
      <button type="button" className="ghost small" onClick={() => void copy()}>
        {L('コピー', 'Copy')}
      </button>
      <span className="small" role="status">
        {copyState === 'copied' ? L('コピーしました', 'Copied') : copyState === 'failed' ? L('コピーできませんでした', 'Could not copy') : ''}
      </span>
    </div>
    <pre><code>{code}</code></pre>
  </div>
}

const components: Components = {
  a: ({ href, children }) => href ? <a href={href} onClick={(e) => { e.preventDefault(); openExternal(href) }}
    onAuxClick={(e) => { e.preventDefault(); if (e.button === 1) openExternal(href) }}>{children}</a> : <span>{children}</span>,
  // Markdown images never load, including local, remote, and data URLs.
  img: ({ alt }) => <span className="muted">[{alt || L('画像', 'Image')}]</span>,
  pre: ({ node }) => {
    const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
    if (!code || code.type !== 'element') return null
    const value = code.children.map((child) => child.type === 'text' ? child.value : '').join('')
    const language = /language-([^\s,]+)/.exec(String(code.properties.className ?? ''))?.[1] ?? ''
    return <CodeBlock code={value} language={language} />
  },
  table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
}

/** Presentation only. language participates in memo comparison so translated controls update. */
export const MessageBody = memo(function MessageBody({ text, markdown = true }: { text: string; markdown?: boolean; language?: Lang }) {
  if (!markdown) return <div className="msg-body"><div className="pre">{text}</div></div>
  return <div className="msg-body markdown-body">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml
      urlTransform={(url, key) => key === 'href' ? safeMarkdownUrl(url) : ''}
      components={components}>{text}</Markdown>
  </div>
})
