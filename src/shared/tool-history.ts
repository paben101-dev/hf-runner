import type { ChatMessage } from './conversations'
import type { ToolActivity, ToolCall, ToolMessage, ToolResult } from './tools'

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored tool message')
  return value as Record<string, unknown>
}

/** Stored turns contain assistant/tool messages only, with every call paired before continuation. */
export function storedToolMessages(value: unknown): ToolMessage[] {
  if (!Array.isArray(value) || !value.length || value.length > 256 || JSON.stringify(value).length > 8 * 1024 * 1024) throw new Error('Invalid stored tool turn')
  const pending = new Set<string>(), seen = new Set<string>()
  const result: ToolMessage[] = []
  for (const item of value) {
    const m = record(item)
    if (m.role !== 'assistant' && m.role !== 'tool') throw new Error('Invalid stored tool role')
    if (typeof m.content !== 'string' && m.content !== null) throw new Error('Invalid stored tool content')
    const message: ToolMessage = { role: m.role, content: m.content }
    if (m.role === 'assistant') {
      if (pending.size) throw new Error('Stored tool results are missing')
      if (m.reasoning_content !== undefined) {
        if (typeof m.reasoning_content !== 'string') throw new Error('Invalid stored reasoning')
        message.reasoning_content = m.reasoning_content
      }
      if (m.tool_calls !== undefined) {
        if (!Array.isArray(m.tool_calls) || !m.tool_calls.length || m.tool_calls.length > 16) throw new Error('Invalid stored tool calls')
        message.tool_calls = m.tool_calls.map((entry): ToolCall => {
          const call = record(entry), fn = record(call.function)
          if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 256 || seen.has(call.id)
            || typeof fn.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(fn.name)
            || typeof fn.arguments !== 'string' || fn.arguments.length > 65536) throw new Error('Invalid stored tool call')
          seen.add(call.id); pending.add(call.id)
          return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } }
        })
      }
    } else {
      if (typeof m.tool_call_id !== 'string' || !pending.delete(m.tool_call_id) || typeof m.content !== 'string') throw new Error('Unpaired stored tool result')
      message.tool_call_id = m.tool_call_id
    }
    result.push(message)
  }
  if (pending.size || result.at(-1)!.role !== 'assistant' || result.at(-1)!.tool_calls) throw new Error('Incomplete stored tool turn')
  return result
}

/** One UI assistant bubble can represent several protocol messages; never flatten those into prose. */
export function toToolContext(messages: ChatMessage[]): ToolMessage[] {
  return messages.flatMap((message): ToolMessage[] => {
    if (message.role === 'assistant' && message.toolMessages) return storedToolMessages(message.toolMessages)
    const content = message.images?.length ? [{ type: 'text', text: message.content }, ...message.images.map((url) => ({ type: 'image_url', image_url: { url } }))] : message.content
    return [{ role: message.role, content, ...(message.reasoning ? { reasoning_content: message.reasoning } : {}) }]
  })
}

/** Reconstruct activity from the persisted protocol, avoiding duplicate stored result bodies. */
export function toolActivities(messages?: ToolMessage[]): ToolActivity[] {
  const activities = new Map<string, ToolActivity>()
  for (const message of messages ?? []) {
    for (const call of message.tool_calls ?? []) activities.set(call.id, { call, state: 'requested' })
    if (message.role !== 'tool' || !message.tool_call_id) continue
    const activity = activities.get(message.tool_call_id)
    if (!activity) continue
    let result: ToolResult
    try {
      const parsed = record(JSON.parse(String(message.content)))
      if (typeof parsed.ok !== 'boolean') throw new Error('Invalid result')
      result = { ok: parsed.ok, data: parsed.data, ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}) }
    } catch { result = { ok: false, error: 'Could not read stored tool result' } }
    activities.set(message.tool_call_id, { ...activity, state: 'done', result })
  }
  return [...activities.values()]
}
