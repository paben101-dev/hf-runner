import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry as createProductionRegistry, ToolRegistry } from '../src/main/tools'
import { createTestToolRegistry as createToolRegistry } from './fixtures/tool-registry'
import { ToolCallAssembler, toolPreferences, supportsStructuredTools, type ToolCall } from '../src/shared/tools'
const call = (name = 'test_arithmetic', args = '{"operation":"add","a":2,"b":3}'): ToolCall => ({ id: 'call_1', type: 'function', function: { name, arguments: args } })
const signal = () => new AbortController().signal
const registryWith = (execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) => {
  const registry = new ToolRegistry()
  registry.register({ definition: { type: 'function', function: { name: 'test', description: 'test', parameters: { type: 'object', additionalProperties: false } } }, execute })
  return registry
}
describe('ToolRegistry', () => {
  it('ships only the registered web extension and rejects legacy demo calls', async () => {
    const registry = createProductionRegistry()
    expect(registry.definitions().map((tool) => tool.function.name)).toEqual(['web_search'])
    expect((await registry.execute({ ...call(), function: { name: 'calculator', arguments: '{}' } }, { calculator: true }, 1000, signal())).ok).toBe(false)
  })
  it('calculates through the registered schema and returns structured data', async () => {
    const registry = createToolRegistry()
    expect(registry.definitions({ test_arithmetic: true })).toHaveLength(1)
    expect(registry.definitions({})).toHaveLength(0)
    expect(await registry.execute(call(), { test_arithmetic: true }, 1000, signal())).toEqual({ ok: true, data: { value: 5 } })
  })
  it('rejects unknown, disabled and invalid calls without executing code', async () => {
    const registry = createToolRegistry()
    for (const bad of [call('shell'), call('test_arithmetic', 'not json'), call('test_arithmetic', '{"operation":"eval","a":2,"b":3}'), call('test_arithmetic', '{"operation":"add","a":"2","b":3}'), call('test_arithmetic', '{"operation":"add","a":2,"b":3,"command":"rm"}')]) {
      expect((await registry.execute(bad, { test_arithmetic: true }, 1000, signal())).ok).toBe(false)
    }
    expect((await registry.execute(call(), {}, 1000, signal())).error).toContain('disabled')
    expect((await registry.execute(call('test_arithmetic', '{"operation":"divide","a":1,"b":0}'), { test_arithmetic: true }, 1000, signal())).error).toContain('Division by zero')
  })
  it('handles failures, output limits and duplicate registration', async () => {
    const registry = registryWith(async () => { throw new Error('failed') })
    expect((await registry.execute(call('test', '{}'), { test: true }, 1000, signal())).error).toBe('failed')
    const huge = registryWith(async () => 'x'.repeat(70000))
    expect((await huge.execute(call('test', '{}'), { test: true }, 1000, signal())).ok).toBe(false)
    expect(() => registry.register({ definition: registry.definitions()[0], execute: async () => null })).toThrow('duplicate')
  })
  it('times out and propagates abort to cooperative handlers', async () => {
    let aborted = false
    const registry = registryWith(async (_args, toolSignal) => new Promise((_resolve) => { toolSignal.addEventListener('abort', () => { aborted = true }) }))
    expect((await registry.execute(call('test', '{}'), { test: true }, 10, signal())).error).toContain('timed out')
    expect(aborted).toBe(true)
    const controller = new AbortController()
    const promise = registry.execute(call('test', '{}'), { test: true }, 10000, controller.signal)
    controller.abort(new Error('Cancelled'))
    expect((await promise).ok).toBe(false)
  })
  it('does not invoke a handler when already cancelled', async () => {
    const execute = vi.fn(async () => null), registry = registryWith(execute)
    const controller = new AbortController(); controller.abort()
    expect((await registry.execute(call('test', '{}'), { test: true }, 1000, controller.signal)).ok).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
})
describe('ToolCallAssembler', () => {
  it('assembles interleaved names/arguments for multiple structured calls', () => {
    const a = new ToolCallAssembler()
    a.add([{ index: 1, id: 'b', function: { name: 'test_', arguments: '{"a":' } }, { index: 0, id: 'a', function: { name: 'test_arithmetic', arguments: '{}' } }])
    a.add([{ index: 1, function: { name: 'arithmetic', arguments: '2}' } }])
    expect(a.finish().map((c) => c.id)).toEqual(['a', 'b'])
    expect(a.finish()[1].function).toEqual({ name: 'test_arithmetic', arguments: '{"a":2}' })
  })
  it('rejects missing identities, excessive calls and duplicate IDs', () => {
    const a = new ToolCallAssembler(); a.add([{ index: 0, function: { name: 'test_arithmetic' } }])
    expect(() => a.finish()).toThrow('Incomplete')
    expect(() => a.add([{ index: 16 }])).toThrow('index')
    const b = new ToolCallAssembler(); b.add([{ index: 0, id: 'same', function: { name: 'x' } }, { index: 1, id: 'same', function: { name: 'y' } }])
    expect(() => b.finish()).toThrow('duplicate')
  })
  it('rejects unknown or unsupported model/backend capabilities', () => {
    expect(supportsStructuredTools('llamacpp', {})).toBe(false)
    expect(supportsStructuredTools('llamacpp', { chat_template_caps: { supports_tool_calls: true } })).toBe(true)
    expect(supportsStructuredTools('transformers', { tool_calling: true })).toBe(true)
    expect(supportsStructuredTools('transformers', { tool_calling: 'true' })).toBe(false)
    expect(supportsStructuredTools('sdcpp', { tool_calling: true })).toBe(false)
  })
  it('normalizes persisted preferences to bounded, opt-in defaults', () => {
    expect(toolPreferences(undefined).enabled).toBe(false)
    expect(toolPreferences({ enabled: 'true', maxRounds: 100, timeoutMs: 1 })).toMatchObject({ enabled: false, maxRounds: 8, timeoutMs: 100 })
  })
})
