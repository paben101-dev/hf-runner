import { describe, expect, it, vi } from 'vitest'
import { createWebSearchTool, safeSearchUrl } from '../src/main/web-search'
import { runToolChat } from '../src/main/tool-chat'
import { toolPreferences } from '../src/shared/tools'
import { ToolRegistry } from '../src/main/tools'
const call = (args: string) => ({ id: 'search', type: 'function' as const, function: { name: 'web_search', arguments: args } })
function setup() {
  const search = vi.fn(async () => [{ title: 'Result', url: 'https://example.com/source', snippet: 'Untrusted <script>text</script>' }])
  const registry = new ToolRegistry()
  registry.register(createWebSearchTool({ name: 'test', search }))
  return { search, registry }
}
describe('registered web search', () => {
  it('is disabled unless selected and validates inputs before contacting the provider', async () => {
    const { search, registry } = setup()
    expect(registry.definitions({ calculator: true })).toEqual([])
    for (const args of ['{}', '{"query":"   "}', '{"query":"x","count":20}', '{"query":"x","url":"file:///secret"}']) {
      expect((await registry.execute(call(args), { web_search: true }, 1000, new AbortController().signal)).ok).toBe(false)
    }
    expect((await registry.execute(call('{"query":"x"}'), {}, 1000, new AbortController().signal)).ok).toBe(false)
    expect(search).not.toHaveBeenCalled()
  })
  it('returns bounded source data through the normal registry path', async () => {
    const { search, registry } = setup()
    const result = await registry.execute(call('{"query":" current news ","count":1}'), { web_search: true }, 1000, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(search).toHaveBeenCalledWith('current news', 1, expect.any(AbortSignal))
    expect(result.data).toMatchObject({ provider: 'test', results: [{ url: 'https://example.com/source', snippet: 'Untrusted <script>text</script>' }] })
  })
  it('uses the unchanged inference loop and returns search results only as untrusted tool-role data', async () => {
    const { registry, search } = setup()
    const sse = (delta: object, finish: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
    const request = vi.fn().mockResolvedValueOnce(sse({ tool_calls: [{ index: 0, ...call('{"query":"latest news","count":1}') }] }, 'tool_calls')).mockResolvedValueOnce(sse({ content: 'Source: https://example.com/source' }, 'stop'))
    const result = await runToolChat({ id: 'search-turn', url: 'http://127.0.0.1:18080/v1/chat/completions', messages: [{ role: 'user', content: 'Find current news' }], parameters: {}, preferences: toolPreferences({ enabled: true, enabledTools: { web_search: true } }), registry, signal: new AbortController().signal, emit: () => {}, request })
    expect(result.error).toBeUndefined()
    expect(search).toHaveBeenCalledTimes(1)
    const body = JSON.parse(request.mock.calls[1][1].body)
    expect(body.messages[2].role).toBe('tool')
    expect(JSON.parse(body.messages[2].content)).toMatchObject({ ok: true, data: { query: 'latest news', results: [{ url: 'https://example.com/source' }] } })
    expect(body.messages.filter((m: {role: string}) => m.role === 'system')).toEqual([])
  })
  it('rejects unsafe link schemes without fetching result URLs', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,a', 'hfimg://a', 'https://user:password@example.com', '/relative']) expect(safeSearchUrl(url)).toBeNull()
  })
})
