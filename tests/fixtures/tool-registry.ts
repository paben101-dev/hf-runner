// Test-only arithmetic handler; never registered or bundled in the application.
import { ToolRegistry } from '../../src/main/tools'

export function createTestToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    definition: { type: 'function', function: {
      name: 'test_arithmetic', description: 'Calculate one arithmetic operation on two finite numbers.',
      parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] }, a: { type: 'number' }, b: { type: 'number' } }, required: ['operation', 'a', 'b'], additionalProperties: false },
    } },
    execute: async ({ operation, a, b }, signal) => {
      signal.throwIfAborted()
      const x = a as number, y = b as number
      if (operation === 'divide' && y === 0) throw new Error('Division by zero')
      const value = operation === 'add' ? x + y : operation === 'subtract' ? x - y : operation === 'multiply' ? x * y : x / y
      if (!Number.isFinite(value)) throw new Error('Result is not finite')
      return { value }
    },
  })
  return registry
}
