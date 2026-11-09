export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | Array<Record<string, unknown>> | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}
export interface ToolResult { ok: boolean; data?: unknown; error?: string }
export interface ToolActivity { call: ToolCall; state: 'requested' | 'running' | 'done'; result?: ToolResult }
export interface ToolChatEvent {
  id: string
  content?: string
  reasoning?: string
  activity?: ToolActivity
}
export interface ToolChatResult { messages: ToolMessage[]; content: string; reasoning: string; error?: string; completionTokens?: number; elapsedMs: number }
export interface ToolPreferences { enabled: boolean; enabledTools: Record<string, boolean>; maxRounds: number; timeoutMs: number }
export const DEFAULT_TOOL_PREFERENCES: ToolPreferences = { enabled: false, enabledTools: { calculator: true }, maxRounds: 3, timeoutMs: 10000 }
export function toolPreferences(value: unknown): ToolPreferences {
  const v = value && typeof value === 'object' ? value as Partial<ToolPreferences> : {}
  return {
    enabled: v.enabled === true,
    enabledTools: v.enabledTools && typeof v.enabledTools === 'object' && !Array.isArray(v.enabledTools)
      ? Object.fromEntries(Object.entries(v.enabledTools).filter(([k, x]) => /^[a-z][a-z0-9_]{0,63}$/.test(k) && typeof x === 'boolean')) : { calculator: true },
    maxRounds: Number.isInteger(v.maxRounds) ? Math.max(1, Math.min(8, v.maxRounds!)) : 3,
    timeoutMs: Number.isInteger(v.timeoutMs) ? Math.max(100, Math.min(30000, v.timeoutMs!)) : 10000,
  }
}

/** Structured deltas only. Ordinary assistant prose is never treated as a tool request. */
export class ToolCallAssembler {
  private calls = new Map<number, ToolCall>()
  add(deltas: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>): void {
    if (!Array.isArray(deltas) || deltas.length > 16) throw new Error('Too many tool calls')
    for (const delta of deltas) {
      if (!Number.isInteger(delta.index) || delta.index! < 0 || delta.index! >= 16) throw new Error('Invalid tool-call index')
      if (delta.type && delta.type !== 'function') throw new Error('Unsupported tool-call type')
      const call = this.calls.get(delta.index!) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (delta.id) {
        if (call.id && call.id !== delta.id) throw new Error('Tool-call ID changed')
        call.id = delta.id
      }
      call.function.name += delta.function?.name ?? ''
      call.function.arguments += delta.function?.arguments ?? ''
      if (call.id.length > 256 || call.function.name.length > 64 || call.function.arguments.length > 65536) throw new Error('Tool call is too large')
      this.calls.set(delta.index!, call)
    }
  }
  finish(): ToolCall[] {
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    if (calls.some((c) => !c.id || !/^[a-z][a-z0-9_]{0,63}$/.test(c.function.name)) || new Set(calls.map((c) => c.id)).size !== calls.length) throw new Error('Incomplete or duplicate tool calls')
    return calls
  }
}

/** Unknown capability metadata is not evidence of tool support. */
export function supportsStructuredTools(engine: string | undefined, props: unknown): boolean {
  if (!props || typeof props !== 'object') return false
  const value = props as { tool_calling?: boolean; chat_template_caps?: { supports_tool_calls?: boolean } }
  return engine === 'transformers' ? value.tool_calling === true : engine === 'llamacpp' && value.chat_template_caps?.supports_tool_calls === true
}
