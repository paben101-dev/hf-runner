// @vitest-environment happy-dom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ConversationStore } from '../src/main/conversations'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../src/shared/conversations'
import { ChatPage } from '../src/renderer/src/pages/ChatPage'
import { setLang } from '../src/shared/i18n'

const mock = vi.hoisted(() => ({
  app: {} as Record<string, any>,
  api: { conversations: { list: vi.fn(), load: vi.fn(), save: vi.fn(), rename: vi.fn(), delete: vi.fn(), menu: vi.fn() } },
}))
vi.mock('../src/renderer/src/App', () => ({ useApp: () => mock.app }))
vi.mock('../src/renderer/src/api', () => ({ api: mock.api, openExternal: vi.fn() }))
const stored = new Map<string, Conversation>()
const makeChat = (id: string, content: string): Conversation => ({ id, title: content, createdAt: 1, updatedAt: 2, modelId: 'model-a', modelName: 'Model A', messages: [{ role: 'user', content }] })
let root: Root
let container: HTMLDivElement
const settle = async (callback = () => {}) => { await act(async () => { callback(); await new Promise((r) => setTimeout(r, 0)) }) }
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  expect(button, text).toBeTruthy()
  await settle(() => button!.click())
}
const composer = () => container.querySelector('.composer textarea') as HTMLTextAreaElement
const submit = async (text: string) => {
  await settle(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), text)
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle(() => container.querySelector('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
beforeEach(async () => {
  vi.clearAllMocks()
  stored.clear()
  setLang('en')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  mock.app = { page: 'chat', server: { state: 'running', modelId: 'model-a', modelName: 'Model A', port: 18080 }, settings: {}, toast: vi.fn(), setPage: vi.fn() }
  mock.api.conversations.list.mockImplementation(async () => [...stored.values()].map((c) => ({ ...c, messages: [] })))
  mock.api.conversations.load.mockImplementation(async (id) => structuredClone(stored.get(id) ?? null))
  mock.api.conversations.save.mockImplementation(async (c) => { stored.set(c.id, structuredClone(c)) })
  mock.api.conversations.delete.mockImplementation(async (id) => stored.delete(id))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } })))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const mount = () => settle(() => root.render(<ChatPage />))

describe('chat history interactions', () => {
  it('restores independent chats and prevents a late load from replacing the selected chat', async () => {
    stored.set('one', makeChat('one', 'first')); stored.set('two', makeChat('two', 'second'))
    await mount()
    let resolve!: (c: Conversation) => void
    mock.api.conversations.load.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    await click('firstModel A')
    expect([...container.querySelectorAll('.conversation-list button')].every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    await settle(() => resolve(makeChat('one', 'first')))
    expect(container.querySelector('.messages')!.textContent).toContain('first')
    await click('secondModel A')
    expect(container.querySelector('.messages')!.textContent).toContain('second')
    expect(container.querySelector('.messages')!.textContent).not.toContain('first')
  })
  it('keeps the input enabled and focused after deleting both conversations or starting New Chat', async () => {
    stored.set('one', makeChat('one', 'first')); stored.set('two', makeChat('two', 'second'))
    await mount(); await click('firstModel A'); await click('Delete')
    await click('secondModel A'); await click('Delete')
    expect(stored.size).toBe(0)
    expect(composer().disabled).toBe(false)
    expect(document.activeElement).toBe(composer())
    await click('New Chat')
    expect(document.activeElement).toBe(composer())
    expect(composer().disabled).toBe(false)
  })
  it('retains unsaved messages/model identity and refuses to switch until a retry succeeds', async () => {
    await mount()
    mock.api.conversations.save.mockRejectedValue(new Error('disk full'))
    await submit('keep this')
    expect(container.querySelector('.messages')!.textContent).toContain('keep this')
    await click('New Chat')
    expect(container.querySelector('.messages')!.textContent).toContain('keep this')
    expect(mock.app.toast).toHaveBeenCalled()
    mock.app.server = { ...mock.app.server, modelId: 'other' }
    await mount()
    expect(composer().disabled).toBe(true)
    mock.api.conversations.save.mockImplementation(async (c) => { stored.set(c.id, structuredClone(c)) })
    await click('New Chat')
    expect([...stored.values()][0]).toMatchObject({ modelId: 'model-a', messages: [{ content: 'keep this' }] })
    expect(container.querySelector('.messages')!.textContent).not.toContain('keep this')
  })
  it('discards image processing that finishes after starting a different blank chat', async () => {
    mock.app.server.vision = true
    await mount()
    let finish!: (bitmap: object) => void
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise((resolve) => { finish = resolve })))
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
    const data = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,aGVsbG8=')
    try {
      const file = container.querySelector('input[type=file]')!
      Object.defineProperty(file, 'files', { value: [new File(['image'], 'image.png', { type: 'image/png' })] })
      await settle(() => file.dispatchEvent(new Event('change', { bubbles: true })))
      await click('New Chat')
      await settle(() => finish({ width: 1, height: 1, close: vi.fn() }))
      expect(container.querySelector('.attach-strip')).toBeNull()
    } finally { context.mockRestore(); data.mockRestore() }
  })
  it('continues inference when only the sidebar refresh fails after a successful save', async () => {
    await mount()
    mock.api.conversations.list.mockRejectedValueOnce(new Error('listing failed'))
    await submit('question')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect([...stored.values()][0].messages).toHaveLength(2)
  })
  it('renders restarted history with Markdown, toggles presentation only, and sends raw text with attachments', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfr-integrated-'))
    try {
      const c = makeChat(randomUUID(), '# raw user')
      const raw = '## Answer\n\n**bold**\n\n```js\n  const x = 1\n```'
      const image = 'data:image/png;base64,aGVsbG8='
      c.messages[0].images = [image]
      c.messages.push({ role: 'assistant', content: raw, reasoning: 'reasoning **stays raw**' })
      new ConversationStore(dir).save(c)
      // Each load creates a fresh store, exercising the persisted representation rather than renderer memory.
      mock.api.conversations.list.mockImplementation(async () => new ConversationStore(dir).list())
      mock.api.conversations.load.mockImplementation(async (id) => new ConversationStore(dir).load(id))
      mock.api.conversations.save.mockImplementation(async (record) => new ConversationStore(dir).save(record))
      mock.app.settings = { renderMarkdown: true }
      mock.app.server.engine = 'llamacpp'
      await mount(); await click('# raw userModel A')
      expect(container.querySelector('.msg.assistant h2')!.textContent).toBe('Answer')
      expect(container.querySelector('.msg.assistant strong')!.textContent).toBe('bold')
      expect(container.querySelector('.msg-images img')!.getAttribute('src')).toBe(image)
      expect(container.querySelector('.reasoning .pre')!.textContent).toBe('reasoning **stays raw**')
      const file = path.join(dir, 'conversations', c.id, 'conversation.json')
      const before = fs.readFileSync(file, 'utf8')
      mock.app.settings = { renderMarkdown: false }
      await mount()
      expect(container.querySelector('.msg.assistant h2')).toBeNull()
      expect(container.querySelector('.msg.assistant .msg-body')!.textContent).toBe(raw)
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
      mock.app.settings = { renderMarkdown: true }
      mock.app.server.engine = 'transformers'
      await mount()
      expect(container.querySelector('.msg.assistant h2')!.textContent).toBe('Answer')
      await submit('follow up')
      const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]!.body))
      expect(request.messages[0].content).toEqual([{ type: 'text', text: '# raw user' }, { type: 'image_url', image_url: { url: image } }])
      expect(request.messages[1].content).toBe(raw)
      expect(new ConversationStore(dir).load(c.id)!.messages[1].content).toBe(raw)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('keeps switching locked while streaming and saves stopped text and reasoning to the original chat', async () => {
    await mount()
    let rejectRead!: (e: Error) => void
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
      let read = false
      return { ok: true, body: { getReader: () => ({ read: async () => {
        if (!read) { read = true; return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial","reasoning_content":"thought"}}]}\n\n') } }
        return new Promise((_r, reject) => { rejectRead = reject; opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })
      } }) } }
    }))
    await submit('question')
    expect((container.querySelector('.conversation-sidebar > button:nth-child(2)') as HTMLButtonElement).disabled).toBe(true)
    expect(rejectRead).toBeDefined()
    await click('■ Stop')
    expect([...stored.values()][0].messages[1]).toMatchObject({ content: 'partial\n\n(Stopped)', reasoning: 'thought' })
    await click('New Chat')
    await click('questionModel A')
    expect(container.querySelector('.messages')!.textContent).toContain('partial')
  })
})
