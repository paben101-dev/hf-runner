import { ToolCallAssembler, type ToolChatEvent, type ToolChatResult, type ToolMessage, type ToolPreferences, type ToolCall } from '@shared/tools'
import type { ToolRegistry } from './tools'

interface CompletionDelta {
  content?: string
  reasoning_content?: string
  tool_calls?: Parameters<ToolCallAssembler['add']>[0]
}

/** Parse SSE across arbitrary byte boundaries, including CRLF and a final unterminated frame. */
export async function readCompletion(response: Response, signal: AbortSignal, onDelta: (delta: CompletionDelta) => void, onUsage?: (tokens: number) => void): Promise<string | undefined> {
  if (!response.ok || !response.body) throw new Error(`Inference HTTP ${response.status}: ${(await response.text()).slice(0, 2048)}`)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', finish: string | undefined, doneEvent = false
  const frame = (value: string) => {
    const data = value.split('\n').filter((s) => s.startsWith('data:')).map((s) => s.slice(5).trimStart()).join('\n')
    if (!data) return
    if (data === '[DONE]') { doneEvent = true; return }
    const chunk = JSON.parse(data) as { error?: string | { message: string }; choices?: Array<{ delta?: CompletionDelta; finish_reason?: string }>; usage?: { completion_tokens?: number } }
    if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message)
    if (Number.isFinite(chunk.usage?.completion_tokens) && chunk.usage!.completion_tokens! >= 0) onUsage?.(chunk.usage!.completion_tokens!)
    const choice = chunk.choices?.[0]
    if (choice?.delta) onDelta(choice.delta)
    if (choice?.finish_reason) finish = choice.finish_reason
  }
  try {
    while (!doneEvent) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      if (buffer.length > 1024 * 1024) throw new Error('Inference frame too large')
      let index: number
      while ((index = buffer.indexOf('\n\n')) >= 0) { const event = buffer.slice(0, index); buffer = buffer.slice(index + 2); frame(event); if (doneEvent) break }
      if (done) { if (buffer.trim()) frame(buffer); break }
    }
    if (!finish) throw new Error('Inference stream ended without a finish reason')
    return finish
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function runToolChat(options: {
  id: string; url: string; messages: ToolMessage[]; parameters: Record<string, unknown>; preferences: ToolPreferences
  registry: ToolRegistry; signal: AbortSignal; emit(event: ToolChatEvent): void; request?: typeof fetch
}): Promise<ToolChatResult> {
  const { id, registry, signal, emit, preferences } = options
  const messages = structuredClone(options.messages)
  const definitions = preferences.enabled ? registry.definitions(preferences.enabledTools) : []
  let content = '', reasoning = '', pendingContent = ''
  let completionTokens: number | undefined
  const started = performance.now()
  const seen = new Set<string>()
  const pendingCalls = new Map<string, ToolCall>()
  try {
    for (let round = 0; ; round++) {
      signal.throwIfAborted()
      let turnContent = '', turnReasoning = ''
      pendingContent = ''
      let lastEmit = 0
      const calls = new ToolCallAssembler()
      const response = await (options.request ?? fetch)(options.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ ...options.parameters, messages, stream: true, stream_options: { include_usage: true }, ...(definitions.length ? { tools: definitions, tool_choice: 'auto' } : {}) }) })
      const finish = await readCompletion(response, signal, (delta) => {
        if (typeof delta.content === 'string') { turnContent += delta.content; pendingContent += delta.content; content += delta.content }
        if (typeof delta.reasoning_content === 'string') { turnReasoning += delta.reasoning_content; reasoning += delta.reasoning_content }
        if (content.length + reasoning.length > 4 * 1024 * 1024) throw new Error('Response too large')
        if (delta.tool_calls) calls.add(delta.tool_calls)
        if (performance.now() - lastEmit > 40) { emit({ id, content, reasoning }); lastEmit = performance.now() }
      }, (tokens) => { completionTokens = (completionTokens ?? 0) + tokens })
      emit({ id, content, reasoning })
      const requested = calls.finish()
      if (!requested.length) {
        if (finish === 'tool_calls') throw new Error('Model returned incomplete tool calls')
        messages.push({ role: 'assistant', content: turnContent, ...(turnReasoning ? { reasoning_content: turnReasoning } : {}) })
        return { messages, content, reasoning, completionTokens, elapsedMs: performance.now() - started }
      }
      for (const call of requested) { pendingCalls.set(call.id, call); emit({ id, activity: { call, state: 'requested' } }) }
      if (finish !== 'tool_calls') throw new Error('Model did not finish its tool-call response; no tools were executed')
      if (!definitions.length) throw new Error('Model requested tools while tools are disabled')
      if (round >= preferences.maxRounds) throw new Error('Maximum tool-call rounds reached')
      if (requested.some((c) => seen.has(c.id))) throw new Error('Model reused a tool-call ID')
      messages.push({ role: 'assistant', content: turnContent || null, ...(turnReasoning ? { reasoning_content: turnReasoning } : {}), tool_calls: requested })
      pendingContent = ''
      for (const call of requested) {
        seen.add(call.id)
        signal.throwIfAborted()
        emit({ id, activity: { call, state: 'running' } })
        const result = await registry.execute(call, preferences.enabledTools, preferences.timeoutMs, signal)
        emit({ id, activity: { call, state: 'done', result } })
        pendingCalls.delete(call.id)
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      }
    }
  } catch (e) {
    // Never leave a half-completed tool exchange in the next request's context.
    const lastAssistant = messages.findLastIndex((m) => m.role === 'assistant' && !!m.tool_calls)
    if (lastAssistant >= 0) {
      const expected = messages[lastAssistant].tool_calls!
      const completed = new Set(messages.slice(lastAssistant + 1).map((m) => m.tool_call_id))
      for (const call of expected) if (!completed.has(call.id)) messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'Cancelled before completion' }) })
    }
    const error = signal.aborted ? 'Stopped' : e instanceof Error ? e.message : String(e)
    for (const call of pendingCalls.values()) emit({ id, activity: { call, state: 'done', result: { ok: false, error } } })
    messages.push({ role: 'assistant', content: pendingContent || error })
    return { messages, content, reasoning, error, completionTokens, elapsedMs: performance.now() - started }
  }
}
