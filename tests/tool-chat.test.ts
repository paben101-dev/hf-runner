import { createServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { runToolChat, readCompletion } from '../src/main/tool-chat'
import { createTestToolRegistry as createToolRegistry } from './fixtures/tool-registry'
import { toolPreferences, type ToolChatEvent } from '../src/shared/tools'
const sse = (deltas: object[], finish = 'stop', crlf = false) => {
  const text = [...deltas.map((delta) => JSON.stringify({ choices: [{ delta }] })), JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] }), '[DONE]'].map((s) => `data: ${s}\n\n`).join('')
  const bytes = new TextEncoder().encode(crlf ? text.replace(/\n/g, '\r\n') : text)
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close() } }))
}
const calls = (count = 1) => Array.from({ length: count }, (_, index) => ({ index, id: `call_${index}`, type: 'function', function: { name: 'test_arithmetic', arguments: '{"operation":"multiply","a":6,"b":7}' } }))
const run = (request: typeof fetch, prefs = toolPreferences({ enabled: true, enabledTools: { test_arithmetic: true } }), signal = new AbortController().signal, emit = (_e: ToolChatEvent) => {}) => runToolChat({ id: 'session', url: 'http://127.0.0.1:18080/v1/chat/completions', messages: [{ role: 'user', content: 'calculate' }], parameters: { temperature: 0 }, preferences: prefs, registry: createToolRegistry(), signal, emit, request })
describe('tool inference loop', () => {
  it('streams single/multiple tool calls, appends tool-role results and continues inference', async () => {
    for (const count of [1, 2]) {
      const events: ToolChatEvent[] = []
      const request = vi.fn().mockResolvedValueOnce(sse([{ tool_calls: calls(count) }], 'tool_calls')).mockResolvedValueOnce(sse([{ reasoning_content: 'reason' }, { content: 'Answer 42' }], 'stop', true))
      const result = await run(request, undefined, undefined, (e) => events.push(e))
      expect(result.error).toBeUndefined()
      expect(result.content).toBe('Answer 42')
      const second = JSON.parse(request.mock.calls[1][1].body)
      expect(second.messages.filter((m: { role: string }) => m.role === 'tool')).toHaveLength(count)
      expect(JSON.parse(second.messages[2].content)).toEqual({ ok: true, data: { value: 42 } })
      expect(events.filter((e) => e.activity?.state === 'done')).toHaveLength(count)
      expect(second.messages.some((m: { role: string }) => m.role === 'system')).toBe(false)
    }
  })
  it('returns validation errors to the model instead of throwing or executing unknown tools', async () => {
    const invalid = calls(); invalid[0].function.name = 'shell'
    const request = vi.fn().mockResolvedValueOnce(sse([{ tool_calls: invalid }], 'tool_calls')).mockResolvedValueOnce(sse([{ content: 'Unavailable' }]))
    const result = await run(request)
    expect(result.error).toBeUndefined()
    expect(JSON.parse(result.messages[2].content as string).ok).toBe(false)
  })
  it('enforces the round limit without executing an extra round', async () => {
    const request = vi.fn().mockImplementation(async () => sse([{ tool_calls: [{ ...calls()[0], id: `id_${request.mock.calls.length}` }] }], 'tool_calls'))
    const result = await run(request, toolPreferences({ enabled: true, enabledTools: { test_arithmetic: true }, maxRounds: 1 }))
    expect(result.error).toContain('Maximum')
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(1)
  })
  it('never treats prose as tool calls and omits tool definitions when disabled', async () => {
    const request = vi.fn().mockResolvedValue(sse([{ content: 'test_arithmetic({a:1})' }]))
    const result = await run(request, toolPreferences(undefined))
    expect(result.content).toBe('test_arithmetic({a:1})')
    expect(JSON.parse(request.mock.calls[0][1].body).tools).toBeUndefined()
  })
  it('rejects truncated calls and protocol failures before execution', async () => {
    const result = await run(vi.fn().mockResolvedValue(sse([{ tool_calls: calls() }], 'length')))
    expect(result.error).toContain('no tools were executed')
    expect(result.messages.some((m) => m.role === 'tool')).toBe(false)
    const http = await run(vi.fn().mockResolvedValue(new Response('Unsupported model/template', { status: 400 })))
    expect(http.error).toContain('Unsupported model')
    await expect(readCompletion(new Response('data: {"choices":[]}\n\n'), new AbortController().signal, () => {})).rejects.toThrow('finish reason')
  })
  it('runs the test_arithmetic end-to-end against a local streaming HTTP backend', async () => {
    let requests = 0
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      requests++
      const response = requests === 1 ? sse([{ tool_calls: calls() }], 'tool_calls') : sse([{ content: 'The result is 42' }])
      if (requests === 2) expect(JSON.parse(request.messages[2].content).data.value).toBe(42)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(await response.text())
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address() as { port: number }
      const result = await runToolChat({ id: 'http-session', url: `http://127.0.0.1:${address.port}/v1/chat/completions`, messages: [{ role: 'user', content: '6 times 7' }], parameters: {}, preferences: toolPreferences({ enabled: true, enabledTools: { test_arithmetic: true } }), registry: createToolRegistry(), signal: new AbortController().signal, emit: () => {} })
      expect(result.error).toBeUndefined()
      expect(result.content).toBe('The result is 42')
      expect(requests).toBe(2)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
  it('preserves reasoning in model context and avoids duplicating prior text after a later failure', async () => {
    const request = vi.fn().mockResolvedValueOnce(sse([{ content: 'Calculating.', reasoning_content: 'Need arithmetic', tool_calls: calls() }], 'tool_calls')).mockRejectedValueOnce(new Error('connection failed'))
    const result = await run(request)
    expect(result.messages[1].reasoning_content).toBe('Need arithmetic')
    expect(result.messages.at(-1)!.content).toBe('connection failed')
    expect(result.messages.filter((m) => m.content === 'Calculating.')).toHaveLength(1)
  })
  it('pairs every requested call with a result when cancelled during a batch', async () => {
    const controller = new AbortController()
    const request = vi.fn().mockResolvedValue(sse([{ tool_calls: calls(2) }], 'tool_calls'))
    const result = await run(request, undefined, controller.signal, (event) => { if (event.activity?.state === 'done') controller.abort() })
    expect(result.error).toBe('Stopped')
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(2)
    expect(JSON.parse(result.messages.filter((m) => m.role === 'tool')[1].content as string).ok).toBe(false)
  })
  it('stops before inference when cancelled', async () => {
    const controller = new AbortController(); controller.abort()
    const request = vi.fn()
    expect((await run(request, undefined, controller.signal)).error).toBe('Stopped')
    expect(request).not.toHaveBeenCalled()
  })
})
