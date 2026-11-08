import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }))
vi.mock('../src/main/runtime', () => ({ recommendedBackend: () => 'cpu' }))
vi.mock('../src/main/sdcpp', () => ({ recommendedSdBackend: () => 'cpu' }))
const { SettingsStore } = await import('../src/main/settings')
const dirs: string[] = []
function setup(raw?: object) {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfr-markdown-'))
  dirs.push(state.dir)
  if (raw) fs.writeFileSync(path.join(state.dir, 'settings.json'), JSON.stringify(raw))
  return new SettingsStore()
}
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

describe('Markdown preference', () => {
  it('defaults to enabled for fresh installs and existing settings files', () => {
    expect(setup().get().renderMarkdown).toBe(true)
    const existing = setup({ temperature: 0.4 })
    expect(existing.get().renderMarkdown).toBe(true)
    expect(existing.get().temperature).toBe(0.4)
  })
  it('persists false and true across restarts without changing unrelated settings', () => {
    const store = setup({ temperature: 0.4 })
    store.update({ renderMarkdown: false })
    expect(new SettingsStore().get().renderMarkdown).toBe(false)
    expect(new SettingsStore().get().temperature).toBe(0.4)
    store.update({ renderMarkdown: true })
    expect(new SettingsStore().get().renderMarkdown).toBe(true)
  })
  it('uses the default for malformed preference values and rejects invalid updates', () => {
    const store = setup({ renderMarkdown: 'false' })
    expect(store.get().renderMarkdown).toBe(true)
    store.update({ renderMarkdown: null } as never)
    expect(store.get().renderMarkdown).toBe(true)
  })
})
