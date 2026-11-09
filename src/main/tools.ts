import Ajv from 'ajv'
import type { ToolCall, ToolDefinition, ToolResult } from '@shared/tools'

export interface RegisteredTool {
  definition: ToolDefinition
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}
export class ToolRegistry {
  private tools = new Map<string, { tool: RegisteredTool; validate: ReturnType<Ajv['compile']> }>()
  private ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true })
  register(tool: RegisteredTool): void {
    const name = tool.definition.function.name
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || this.tools.has(name)) throw new Error('Invalid or duplicate tool name')
    this.tools.set(name, { tool, validate: this.ajv.compile(tool.definition.function.parameters) })
  }
  definitions(enabled?: Record<string, boolean>): ToolDefinition[] {
    return [...this.tools.values()].filter(({ tool }) => !enabled || enabled[tool.definition.function.name] === true).map(({ tool }) => structuredClone(tool.definition))
  }
  async execute(call: ToolCall, enabled: Record<string, boolean>, timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
    const entry = this.tools.get(call.function.name)
    if (!entry || enabled[call.function.name] !== true) return { ok: false, error: 'Unknown or disabled tool' }
    if (call.function.arguments.length > 65536) return { ok: false, error: 'Tool arguments exceed 64 KiB' }
    let args: unknown
    try { args = JSON.parse(call.function.arguments) } catch { return { ok: false, error: 'Arguments must be valid JSON' } }
    if (!entry.validate(args)) return { ok: false, error: `Invalid arguments: ${this.ajv.errorsText(entry.validate.errors)}` }
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const timer = setTimeout(() => controller.abort(new Error('Tool execution timed out')), timeoutMs)
    let onAbort: () => void = () => {}
    try {
      combined.throwIfAborted()
      const abort = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(combined.reason ?? new Error('Cancelled'))
        combined.addEventListener('abort', onAbort, { once: true })
      })
      const data = await Promise.race([Promise.resolve().then(() => { combined.throwIfAborted(); return entry.tool.execute(args as Record<string, unknown>, combined) }), abort])
      // Results are untrusted JSON data, never executable code or system instructions.
      const json = JSON.stringify(data ?? null)
      if (json.length > 65536) throw new Error('Tool result exceeds 64 KiB')
      return { ok: true, data: JSON.parse(json) }
    } catch (e) { return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 2048) } }
    finally { clearTimeout(timer); combined.removeEventListener('abort', onAbort) }
  }
}
/** Extension branches register their tools here. The foundation ships no executable demo tools. */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry()
}
