import { parseDocument, DomUtils } from 'htmlparser2'
import { setTimeout as delay } from 'node:timers/promises'
import { safeSearchUrl, type SearchProvider, type SearchResult } from './web-search'

type HtmlElement = ReturnType<typeof DomUtils.findAll>[number]
type Source = 'DuckDuckGo' | 'Bing'
const HOSTS = { DuckDuckGo: 'https://html.duckduckgo.com/html/', Bing: 'https://www.bing.com/search' }
const hasClass = (node: HtmlElement, value: string) => (node.attribs.class ?? '').split(/\s+/).includes(value)
const providerHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)
const plain = (node: HtmlElement) => DomUtils.textContent(node).replace(/\s+/g, ' ').trim()

function resultUrl(href: string, source: Source): string | null {
  try {
    const url = new URL(href, HOSTS[source])
    if (source === 'DuckDuckGo' && providerHost(url.hostname, 'duckduckgo.com')) {
      const target = url.searchParams.get('uddg')
      return target ? safeSearchUrl(target) : null
    }
    if (source === 'Bing' && providerHost(url.hostname, 'bing.com')) {
      const encoded = url.searchParams.get('u')
      if (!encoded?.startsWith('a1') || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded.slice(2))) return null
      return safeSearchUrl(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'))
    }
    return safeSearchUrl(url.href)
  } catch { return null }
}

/** Parse inert HTML only; never execute scripts, request images, or visit result URLs. */
export function parseSearchResults(html: string, source: Source): SearchResult[] {
  const document = parseDocument(html)
  for (const node of DomUtils.findAll((e) => ['script', 'style', 'noscript', 'iframe'].includes(e.name), document.children)) DomUtils.removeElement(node)
  const results: SearchResult[] = []
  if (source === 'DuckDuckGo') {
    for (const anchor of DomUtils.findAll((e) => e.name === 'a' && hasClass(e, 'result__a'), document.children)) {
      let parent = anchor.parent, block: HtmlElement | undefined, ad = false
      while (parent) {
        if ('attribs' in parent) {
          if (hasClass(parent, 'result--ad') || hasClass(parent, 'result__ad')) ad = true
          if (!block && (hasClass(parent, 'result__body') || hasClass(parent, 'result'))) block = parent
        }
        parent = parent.parent
      }
      const url = resultUrl(anchor.attribs.href ?? '', source), title = plain(anchor)
      if (ad || !url || !title) continue
      const snippet = block && DomUtils.findOne((e) => hasClass(e, 'result__snippet'), block.children)
      results.push({ title, url, snippet: snippet ? plain(snippet) : '', source })
    }
  } else {
    for (const block of DomUtils.findAll((e) => e.name === 'li' && hasClass(e, 'b_algo'), document.children)) {
      const heading = DomUtils.findOne((e) => e.name === 'h2', block.children)
      const anchor = heading && DomUtils.findOne((e) => e.name === 'a', heading.children)
      if (!anchor) continue
      const url = resultUrl(anchor.attribs.href ?? '', source), title = plain(anchor)
      if (!url || !title) continue
      const snippet = DomUtils.findOne((e) => e.name === 'p', block.children)
      results.push({ title, url, snippet: snippet ? plain(snippet) : '', source })
    }
  }
  const seen = new Set<string>()
  return results.filter((row) => !seen.has(row.url) && !!seen.add(row.url)).slice(0, 5)
    .map((row) => ({ ...row, title: row.title.slice(0, 300), snippet: row.snippet.slice(0, 1200) }))
}

export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0
  const seconds = Number(value)
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(duration) ? Math.max(0, Math.min(86400000, duration)) : 0
}

async function readPage(response: Response): Promise<string> {
  const type = response.headers.get('content-type') ?? ''
  if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error('Search provider returned an unsupported content type')
  if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('Search response exceeds 1 MiB')
  if (!response.body) throw new Error('Empty search response')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let text = '', size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > 1024 * 1024) throw new Error('Search response exceeds 1 MiB')
      text += decoder.decode(value, { stream: true })
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Session-only cache, serialized requests, and per-provider backoff. No browser automation or challenge bypass. */
export function createKeylessSearch(options: {
  request?: typeof fetch
  now?: () => number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
} = {}): SearchProvider {
  const request = options.request ?? fetch, now = options.now ?? Date.now
  const wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }) })
  const state = { DuckDuckGo: { next: 0, blocked: 0, failures: 0, recent: [] as number[] }, Bing: { next: 0, blocked: 0, failures: 0, recent: [] as number[] } }
  const cache = new Map<string, { expires: number; results: SearchResult[] }>()
  const store = (key: string, results: SearchResult[]) => {
    if (!cache.has(key) && cache.size >= 50) cache.delete(cache.keys().next().value!)
    cache.set(key, { expires: now() + 30 * 60 * 1000, results })
  }
  let busy = false
  return {
    name: 'DuckDuckGo / Bing (keyless)',
    search: async (query, count, signal) => {
      signal.throwIfAborted()
      const key = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
      const hit = cache.get(key)
      if (hit && hit.expires > now()) return structuredClone(hit.results.slice(0, count))
      if (busy) throw new Error('Another search is in progress; try again after it finishes')
      busy = true
      let empty = false
      try {
        for (const source of ['DuckDuckGo', 'Bing'] as const) {
          const current = state[source]
          current.recent = current.recent.filter((time) => time > now() - 60000)
          if (current.blocked > now() || current.recent.length >= 8) continue
          let retry = 0
          try {
            if (current.next > now()) await wait(current.next - now(), signal)
            signal.throwIfAborted()
            current.next = now() + 3000
            current.recent.push(now())
            const url = new URL(HOSTS[source])
            const init: RequestInit = { redirect: 'manual', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]), headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'HFRunner/0.1.1 (keyless web search)' } }
            if (source === 'DuckDuckGo') {
              init.method = 'POST'
              init.body = new URLSearchParams({ q: query })
            } else { url.searchParams.set('q', query); url.searchParams.set('count', '10') }
            const response = await request(url, init)
            retry = retryAfterMs(response.headers.get('retry-after'), now())
            if (!response.ok || response.status === 202 || response.status === 204) {
              void response.body?.cancel().catch(() => {})
              throw new Error(`Search provider HTTP ${response.status}`)
            }
            const html = await readPage(response)
            const results = parseSearchResults(html, source)
            if (!results.length && /captcha|anomaly-modal|anomaly\.js|unusual traffic|challenge-form|verify you are human/i.test(html)) throw new Error('Search provider requires human verification')
            if (!results.length && !/no results|no-results|class=["'][^"']*\bb_no\b/i.test(html)) throw new Error('Search page format was not recognized')
            current.failures = 0
            if (!results.length) { empty = true; continue }
            store(key, results)
            return structuredClone(results.slice(0, count))
          } catch {
            signal.throwIfAborted()
            current.failures = Math.min(5, current.failures + 1)
            current.blocked = now() + Math.max(Math.min(600000, 60000 * 2 ** (current.failures - 1)), retry)
          }
        }
        if (empty) {
          store(key, [])
          return []
        }
        throw new Error('Web search is temporarily unavailable. Providers may be blocked, unreachable, or cooling down. Try again later.')
      } finally { busy = false }
    },
  }
}
