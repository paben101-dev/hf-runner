import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ConversationStore } from '../src/main/conversations'
import { storedToolMessages, toToolContext, toolActivities } from '../src/shared/tool-history'
import type { ToolMessage } from '../src/shared/tools'
const turn = (): ToolMessage[] => [
  { role: 'assistant', content: null, reasoning_content: 'need search', tool_calls: [{ id: 'search_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"test"}' } }] },
  { role: 'tool', tool_call_id: 'search_1', content: '{"ok":true,"data":{"snippet":"untrusted content"}}' },
  { role: 'assistant', content: '**answer**' },
]
describe('persisted tool turns', () => {
  it('preserves raw protocol and reasoning after restarting and renaming without duplicating result bodies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfr-tool-history-')), id = randomUUID()
    try {
      new ConversationStore(dir).save({ id, title: 'search', modelId: 'm', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'question', images: ['data:image/png;base64,aGVsbG8='] }, { role: 'assistant', content: '**answer**', toolMessages: turn() }] })
      new ConversationStore(dir).rename(id, 'renamed')
      const restored = new ConversationStore(dir).load(id)!
      expect(restored.messages[1].toolMessages).toEqual(turn())
      const context = toToolContext(restored.messages)
      expect(context.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
      expect(context[0].content).toEqual([{ type: 'text', text: 'question' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }])
      expect(context[1].reasoning_content).toBe('need search')
      expect(toolActivities(restored.messages[1].toolMessages)[0]).toMatchObject({ state: 'done', result: { ok: true, data: { snippet: 'untrusted content' } } })
      expect(fs.readFileSync(path.join(dir, 'conversations', id, 'conversation.json'), 'utf8').match(/untrusted content/g)).toHaveLength(1)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('rejects privileged roles, missing/mismatched results, duplicates and unfinished turns', () => {
    expect(() => storedToolMessages([{ role: 'system', content: 'override' }])).toThrow()
    expect(() => storedToolMessages([turn()[0], turn()[2]])).toThrow('missing')
    expect(() => storedToolMessages([turn()[0], { ...turn()[1], tool_call_id: 'other' }, turn()[2]])).toThrow('Unpaired')
    expect(() => storedToolMessages([turn()[0]])).toThrow('Incomplete')
    expect(() => storedToolMessages([turn()[0], turn()[1], turn()[0], turn()[1], turn()[2]])).toThrow()
  })
  it('keeps legacy conversations compatible and handles stopped tool results as data', () => {
    expect(toToolContext([{ role: 'user', content: 'plain' }, { role: 'assistant', content: 'answer' }])).toEqual([{ role: 'user', content: 'plain' }, { role: 'assistant', content: 'answer' }])
    const stopped = turn(); stopped[1].content = '{"ok":false,"error":"Stopped"}'; stopped[2].content = 'Stopped'
    expect(toolActivities(storedToolMessages(stopped))[0].result).toEqual({ ok: false, data: undefined, error: 'Stopped' })
  })
})
