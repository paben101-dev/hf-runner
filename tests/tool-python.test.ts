import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('validates the Transformers tool protocol and normal-chat compatibility without model dependencies', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'unittest', 'discover', '-s', 'tests/python', '-p', 'test_tool_protocol.py', '-v'], { encoding: 'utf8' })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toContain('Ran 6 tests')
})
