import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }))
vi.mock('../src/main/runtime', () => ({ recommendedBackend: () => 'cpu' }))
vi.mock('../src/main/sdcpp', () => ({ recommendedSdBackend: () => 'cpu' }))
const { SettingsStore } = await import('../src/main/settings')
afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }))
it('keeps tool execution opt-in for existing users and persists per-tool choices and bounded limits', () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfr-tools-settings-'))
  fs.writeFileSync(path.join(state.dir, 'settings.json'), JSON.stringify({ temperature: 0.4 }))
  const store = new SettingsStore()
  expect(store.get().tools).toMatchObject({ enabled: false, enabledTools: {}, maxRounds: 3 })
  store.update({ tools: { enabled: true, enabledTools: { test_tool: false }, maxRounds: 100, timeoutMs: 1 } })
  const restarted = new SettingsStore()
  expect(restarted.get().tools).toEqual({ enabled: true, enabledTools: { test_tool: false }, maxRounds: 8, timeoutMs: 100 })
  expect(restarted.get().temperature).toBe(0.4)
  store.update({ tools: { ...store.get().tools, enabledTools: { calculator: true, test_tool: true } } })
  expect(new SettingsStore().get().tools.enabledTools).toEqual({ test_tool: true })
})
