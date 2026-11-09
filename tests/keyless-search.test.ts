import { describe, expect, it, vi } from 'vitest'
import { createKeylessSearch, parseSearchResults, retryAfterMs } from '../src/main/keyless-search'
const ddg = `<div class="result"><div class="result__body"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsource">Example &amp; <b>source</b></a></h2><a class="result__snippet">A snippet &lt;script&gt;not executed&lt;/script&gt;.</a></div></div>`
const bing = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${Buffer.from('https://example.net/news').toString('base64url')}">Bing result</a></h2><div class="b_caption"><p>A <strong>news</strong> snippet.</p></div></li>`
const page = (html = ddg, status = 200, headers = {}) => new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
function fixture(request = vi.fn(async () => page())) {
  let time = 100000
  const wait = vi.fn(async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); time += ms })
  const provider = createKeylessSearch({ request, now: () => time, wait })
  const search = (query = 'test', count = 5, signal = new AbortController().signal) => provider.search(query, count, signal)
  return { provider, search, request, wait, advance: (ms: number) => { time += ms } }
}
describe('keyless result parsing', () => {
  it('parses entities, snippets and canonical links without running scripts or fetching pages', () => {
    const rows = parseSearchResults(ddg + ddg + '<script>alert(1)</script>', 'DuckDuckGo')
    expect(rows).toEqual([{ title: 'Example & source', url: 'https://example.com/source', snippet: 'A snippet <script>not executed</script>.', source: 'DuckDuckGo' }])
    expect(parseSearchResults(bing, 'Bing')).toEqual([{ title: 'Bing result', url: 'https://example.net/news', snippet: 'A news snippet.', source: 'Bing' }])
  })
  it('drops ads, provider navigation, unsafe links and malformed redirect targets', () => {
    expect(parseSearchResults(ddg.replace('class="result"', 'class="result result--ad"'), 'DuckDuckGo')).toEqual([])
    expect(parseSearchResults(ddg.replace('https%3A%2F%2Fexample.com%2Fsource', 'file%3A%2F%2Fsecret'), 'DuckDuckGo')).toEqual([])
    expect(parseSearchResults('<li class="b_algo"><h2><a href="/images">Images</a></h2></li>', 'Bing')).toEqual([])
  })
  it('handles both Retry-After forms and rejects malformed values', () => {
    expect(retryAfterMs('120', 1000)).toBe(120000)
    expect(retryAfterMs(new Date(121000).toUTCString(), 1000)).toBe(120000)
    expect(retryAfterMs('bad', 1000)).toBe(0)
  })
})
describe('keyless request policy', () => {
  it('uses only fixed provider hosts, no redirects/cookies, and an in-memory normalized-query cache', async () => {
    const f = fixture()
    expect(await f.search('  Latest   news  ', 1)).toHaveLength(1)
    expect(await f.search('latest news', 5)).toHaveLength(1)
    expect(f.request).toHaveBeenCalledTimes(1)
    const [url, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.href).toBe('https://html.duckduckgo.com/html/')
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit' })
    expect(String(init.body)).toContain('q=')
    f.advance(30 * 60 * 1000 + 1)
    await f.search('latest news')
    expect(f.request).toHaveBeenCalledTimes(2)
  })
  it('falls back to Bing on refusal and observes cooldown/Retry-After instead of retrying DuckDuckGo', async () => {
    const request = vi.fn(async () => page()).mockResolvedValueOnce(page('blocked', 429, { 'retry-after': '120' })).mockImplementation(async () => page(bing))
    const f = fixture(request)
    expect((await f.search())[0].source).toBe('Bing')
    expect((await f.search('other'))[0].source).toBe('Bing')
    expect(request.mock.calls.map((args) => String((args as unknown as [URL])[0])).filter((url) => url.includes('duckduckgo'))).toHaveLength(1)
    f.advance(121000)
    request.mockImplementation(async () => page(ddg))
    await f.search('after cooldown')
    expect(String((request.mock.calls.at(-1) as unknown as [URL])[0])).toContain('duckduckgo')
  })
  it('blocks challenges and unknown layouts without treating them as real no-results pages', async () => {
    const f = fixture(vi.fn(async () => page('<form class="challenge-form">captcha</form>')))
    await expect(f.search()).rejects.toThrow('temporarily unavailable')
    const calls = f.request.mock.calls.length
    await expect(f.search('again')).rejects.toThrow('temporarily unavailable')
    expect(f.request).toHaveBeenCalledTimes(calls)
    const empty = fixture(vi.fn(async () => page('<div>No results found</div>')))
    expect(await empty.search()).toEqual([])
  })
  it('paces requests and limits each source to eight requests per minute', async () => {
    const f = fixture()
    for (let i = 0; i < 8; i++) await f.search(`query ${i}`)
    expect(f.wait).toHaveBeenCalled()
    f.request.mockImplementation(async () => page(bing))
    await f.search('ninth query')
    const urls = f.request.mock.calls.map((args) => String((args as unknown as [URL])[0]))
    expect(urls.filter((url) => url.includes('duckduckgo'))).toHaveLength(8)
    expect(urls.at(-1)).toContain('bing.com')
  })
  it('bounds content sizes and rejects redirects and non-HTML replies', async () => {
    for (const response of [new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }), page('x', 200, { 'content-length': '2000000' }), new Response('{}', { headers: { 'content-type': 'application/json' } }), page('x'.repeat(1024 * 1024 + 1))]) {
      const f = fixture(vi.fn(async () => response.clone()))
      await expect(f.search()).rejects.toThrow('temporarily unavailable')
      expect(f.request).toHaveBeenCalledTimes(2)
    }
  })
  it('propagates cancellation without issuing a fallback request', async () => {
    const controller = new AbortController()
    const f = fixture(vi.fn(async () => { controller.abort(new Error('Stopped')); throw new Error('cancelled') }))
    await expect(f.search('test', 5, controller.signal)).rejects.toThrow('Stopped')
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('rejects parallel searches and releases the provider after the active request finishes', async () => {
    let release!: (response: Response) => void
    const f = fixture(vi.fn(() => new Promise<Response>((resolve) => { release = resolve })))
    const first = f.search('first')
    await expect(f.search('second')).rejects.toThrow('in progress')
    release(page())
    expect(await first).toHaveLength(1)
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('doubles cooldown after repeated refusals', async () => {
    const f = fixture(vi.fn(async () => page('blocked', 429)))
    await expect(f.search('one')).rejects.toThrow()
    f.advance(60001)
    await expect(f.search('two')).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(4)
    f.advance(60001)
    await expect(f.search('three')).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(4)
    f.advance(60000)
    await expect(f.search('four')).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(6)
  })
  it('bounds cached empty results as well as successful pages', async () => {
    const f = fixture(vi.fn(async () => page('No results found')))
    for (let i = 0; i < 51; i++) { await f.search(`empty ${i}`); f.advance(15000) }
    const calls = f.request.mock.calls.length
    await f.search('empty 50')
    expect(f.request).toHaveBeenCalledTimes(calls)
    await f.search('empty 0')
    expect(f.request.mock.calls.length).toBeGreaterThan(calls)
  })
  it('does not cache failures and releases its lock after cancellation', async () => {
    const controller = new AbortController()
    const request = vi.fn(async () => page()).mockImplementationOnce(async () => { controller.abort(new Error('Stopped')); throw new Error('cancelled') })
    const f = fixture(request)
    await expect(f.search('query', 5, controller.signal)).rejects.toThrow('Stopped')
    expect(await f.search('query')).toHaveLength(1)
  })
})
