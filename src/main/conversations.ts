import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Conversation, ChatMessage } from '@shared/conversations'

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const IMAGE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/
const ATTACHMENT = /^[a-f0-9]{64}\.(png|jpeg)$/

/** Synchronous, atomic commits serialize IPC writes and finish before app shutdown. */
export class ConversationStore {
  private readonly dir: string
  constructor(userData: string) {
    this.dir = path.join(userData, 'conversations')
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(this.dir).isSymbolicLink()) throw new Error('Invalid conversation directory')
  }
  private folder(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid conversation ID')
    const folder = path.join(this.dir, id)
    if (fs.existsSync(folder) && (fs.lstatSync(folder).isSymbolicLink() || !fs.lstatSync(folder).isDirectory())) throw new Error('Invalid conversation directory')
    return folder
  }
  list(): Conversation[] {
    return fs.readdirSync(this.dir).filter((id) => ID.test(id)).flatMap((id) => {
      const c = this.read(id, false)
      return c ? [{ ...c, messages: [] }] : []
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  }
  load(id: string): Conversation | null { return this.read(id, true) }
  private read(id: string, attachments: boolean): Conversation | null {
    if (!ID.test(id)) throw new Error('Invalid conversation ID')
    try {
      const folder = this.folder(id)
      if (fs.lstatSync(path.join(folder, 'conversation.json')).isSymbolicLink()) return null
      return this.clean(JSON.parse(fs.readFileSync(path.join(folder, 'conversation.json'), 'utf8')), id, (image) => {
        if (!ATTACHMENT.test(image)) throw new Error('Invalid attachment')
        if (!attachments) return image
        try {
          if (fs.lstatSync(path.join(folder, image)).isSymbolicLink()) return ''
          return `data:image/${path.extname(image).slice(1)};base64,${fs.readFileSync(path.join(folder, image)).toString('base64')}`
        } catch { return '' }
      })
    } catch { return null }
  }
  private clean(value: Conversation, id: string, image: (s: string) => string): Conversation {
    if (!value || value.id !== id || typeof value.title !== 'string' || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || !Array.isArray(value.messages)) throw new Error('Invalid conversation')
    const messages: ChatMessage[] = value.messages.map((m) => {
      if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new Error('Invalid message')
      return {
        role: m.role, content: m.content,
        images: m.images?.map((s) => image(s)).filter(Boolean),
        reasoning: typeof m.reasoning === 'string' ? m.reasoning : undefined,
        stats: typeof m.stats === 'string' ? m.stats : undefined,
        notice: typeof m.notice === 'string' ? m.notice : undefined,
        reasoningMs: Number.isFinite(m.reasoningMs) ? m.reasoningMs : undefined,
      }
    })
    return { id, title: value.title.trim().slice(0, 80) || '💬', createdAt: value.createdAt, updatedAt: value.updatedAt,
      modelId: typeof value.modelId === 'string' ? value.modelId : undefined,
      modelName: typeof value.modelName === 'string' ? value.modelName : undefined, messages }
  }
  save(value: Conversation): void {
    const folder = this.folder(value.id)
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
    const record = this.clean(value, value.id, (image) => {
      const match = IMAGE.exec(image)
      if (!match) throw new Error('Invalid image data')
      const bytes = Buffer.from(match[2], 'base64')
      const name = `${createHash('sha256').update(bytes).digest('hex')}.${match[1]}`
      const file = path.join(folder, name)
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid attachment path')
      if (!fs.existsSync(file)) this.atomicWrite(file, bytes)
      return name
    })
    this.atomicWrite(path.join(folder, 'conversation.json'), JSON.stringify(record))
    // Garbage collection is best effort: a committed save must not be reported as failed.
    const used = new Set(record.messages.flatMap((m) => m.images ?? []))
    let files: string[]
    try { files = fs.readdirSync(folder) } catch { return }
    for (const file of files) {
      if (ATTACHMENT.test(file) && !used.has(file)) {
        try { fs.unlinkSync(path.join(folder, file)) } catch { /* Retry on a later save. */ }
      }
    }
  }
  private atomicWrite(file: string, content: string | Buffer): void {
    const temp = path.join(path.dirname(file), `${randomUUID()}.tmp`)
    try {
      const fd = fs.openSync(temp, 'wx', 0o600)
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temp, file)
    } finally { fs.rmSync(temp, { force: true }) }
  }
  rename(id: string, title: string): void {
    const c = this.read(id, false)
    if (!c) throw new Error('Conversation not found')
    if (typeof title !== 'string' || !title.trim()) throw new Error('Invalid conversation title')
    this.atomicWrite(path.join(this.folder(id), 'conversation.json'), JSON.stringify({ ...c, title: title.trim().slice(0, 80), updatedAt: Date.now() }))
  }
  delete(id: string): void { fs.rmSync(this.folder(id), { recursive: true, force: true }) }
}
