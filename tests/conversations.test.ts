import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore } from '../src/main/conversations'
import { canContinueConversation, conversationTitle, type Conversation } from '../src/shared/conversations'

const dirs: string[] = []
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfr-history-'))
  dirs.push(dir)
  return { dir, store: new ConversationStore(dir) }
}
const conversation = (): Conversation => ({ id: randomUUID(), title: 'Hello', createdAt: 1, updatedAt: 2, modelId: 'repo/model.gguf', modelName: 'Model', messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Partial', reasoning: 'Thinking', reasoningMs: 123, notice: 'Stopped', thinking: true }] })
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

describe('local conversations', () => {
  it('restores messages, reasoning, timestamps and model association after restarting', () => {
    const { dir, store } = setup()
    const c = conversation()
    store.save(c)
    const restored = new ConversationStore(dir).load(c.id)!
    expect(restored).toMatchObject({ ...c, messages: c.messages.map(({ thinking, ...m }) => m) })
    expect(restored.messages[1].thinking).toBeUndefined()
    expect(canContinueConversation(restored, c.modelId)).toBe(true)
    expect(canContinueConversation(restored, 'another-model')).toBe(false)
    expect(canContinueConversation(restored, undefined)).toBe(false)
  })
  it('keeps independent chats while switching and sorts by recent modification', () => {
    const { store } = setup()
    const first = conversation(), second = { ...conversation(), updatedAt: 3 }
    store.save(first); store.save(second)
    expect(store.load(first.id)?.messages[0].content).toBe('Hello')
    expect(store.load(second.id)?.id).toBe(second.id)
    expect(store.list().map((c) => c.id)).toEqual([second.id, first.id])
    store.rename(first.id, 'Renamed')
    expect(store.list()[0].title).toBe('Renamed')
    expect(store.load(first.id)?.modelId).toBe(first.modelId)
  })
  it('stores images separately without duplicate binaries and removes all content on deletion', () => {
    const { store, dir } = setup(), c = conversation()
    const image = 'data:image/png;base64,aGVsbG8='
    c.messages[0].images = [image, image]
    store.save(c)
    const folder = path.join(dir, 'conversations', c.id)
    expect(fs.readdirSync(folder)).toHaveLength(2)
    expect(fs.readFileSync(path.join(folder, 'conversation.json'), 'utf8')).not.toContain('base64')
    expect(store.load(c.id)?.messages[0].images).toEqual([image, image])
    store.delete(c.id)
    expect(fs.existsSync(folder)).toBe(false)
    expect(store.load(c.id)).toBeNull()
  })
  it('handles corrupt/missing records and rejects path traversal and unsafe attachments', () => {
    const { store, dir } = setup(), c = conversation()
    expect(store.load(c.id)).toBeNull()
    store.save(c)
    const file = path.join(dir, 'conversations', c.id, 'conversation.json')
    fs.writeFileSync(file, '{broken')
    expect(store.load(c.id)).toBeNull()
    expect(store.list()).toEqual([])
    expect(() => store.delete('../settings.json')).toThrow()
    c.messages[0].images = ['file:///etc/passwd']
    expect(() => store.save(c)).toThrow()
  })
  it('retains the last committed record if a replacement fails validation', () => {
    const { store } = setup(), c = conversation()
    store.save(c)
    expect(() => store.save({ ...c, messages: [{ role: 'user', content: 'bad', images: ['https://external/image'] }] })).toThrow()
    expect(store.load(c.id)?.messages[0].content).toBe('Hello')
  })
  it('uses the supplied portable data directory without absolute attachment references', () => {
    const { dir } = setup(), c = conversation()
    const portable = path.join(dir, 'data')
    new ConversationStore(portable).save(c)
    const moved = path.join(dir, 'moved')
    fs.renameSync(portable, moved)
    expect(new ConversationStore(moved).load(c.id)?.modelId).toBe(c.modelId)
  })
  it('preserves committed messages and an interrupted response without persisting streaming state', () => {
    const { dir, store } = setup(), c = conversation()
    store.save({ ...c, messages: [c.messages[0]] })
    expect(new ConversationStore(dir).load(c.id)?.messages).toHaveLength(1)
    store.save(c)
    const stopped = new ConversationStore(dir).load(c.id)!
    expect(stopped.messages[1]).toMatchObject({ content: 'Partial', reasoning: 'Thinking', notice: 'Stopped' })
    expect(stopped.messages[1].thinking).toBeUndefined()
  })
  it('keeps the prior JSON if atomic replacement fails', () => {
    const { store } = setup(), c = conversation()
    store.save(c)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk failure') })
    try { expect(() => store.save({ ...c, title: 'New title' })).toThrow('disk failure') }
    finally { rename.mockRestore() }
    expect(store.load(c.id)?.title).toBe('Hello')
  })
  it('tolerates missing image files and strips unknown metadata', () => {
    const { store, dir } = setup(), c = conversation()
    c.messages[0].images = ['data:image/png;base64,aGVsbG8=']
    store.save({ ...c, hfToken: 'not-a-real-token' } as Conversation)
    const folder = path.join(dir, 'conversations', c.id)
    const image = fs.readdirSync(folder).find((f) => f.endsWith('.png'))!
    fs.unlinkSync(path.join(folder, image))
    expect(store.load(c.id)?.messages[0].images).toEqual([])
    expect(fs.readFileSync(path.join(folder, 'conversation.json'), 'utf8')).not.toContain('hfToken')
  })
  it('generates compact titles from the first user message', () => {
    expect(conversationTitle([{ role: 'user', content: '  Hello\n world  ' }])).toBe('Hello world')
    expect(conversationTitle([{ role: 'user', content: 'x'.repeat(100) }])).toHaveLength(80)
    expect(conversationTitle([{ role: 'user', content: '', images: ['image'] }])).toBe('💬')
  })
})
