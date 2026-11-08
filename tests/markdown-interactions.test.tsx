// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBody } from '../src/renderer/src/components/MessageBody'
import { setLang, type Lang } from '../src/shared/i18n'
import { openExternal } from '../src/renderer/src/api'

vi.mock('../src/renderer/src/api', () => ({ openExternal: vi.fn() }))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
const render = async (text: string, language: Lang = 'en', markdown = true) => {
  setLang(language)
  await act(async () => root.render(<MessageBody text={text} language={language} markdown={markdown} />))
}

describe('Markdown interactions', () => {
  it('updates translated controls when only the UI language changes', async () => {
    const code = '```js\nlet x = 1\n```'
    await render(code, 'en')
    expect(container.querySelector('button')!.textContent).toBe('Copy')
    await render(code, 'ja')
    expect(container.querySelector('button')!.textContent).toBe('コピー')
  })
  it('copies original code whitespace without the parser-generated newline', async () => {
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await render('```python\n  first\n\n```\n\n```js\nsecond')
    await act(async () => (container.querySelectorAll('button')[0] as HTMLButtonElement).click())
    expect(write).toHaveBeenLastCalledWith('  first\n')
    await act(async () => (container.querySelectorAll('button')[1] as HTMLButtonElement).click())
    expect(write).toHaveBeenLastCalledWith('second')
  })
  it('shows copy errors and invalidates copied status when streaming adds code', async () => {
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('clipboard denied')).mockResolvedValue()
    await render('```js\none')
    await act(async () => container.querySelector('button')!.click())
    expect(container.textContent).toContain('Could not copy')
    await act(async () => container.querySelector('button')!.click())
    expect(container.textContent).toContain('Copied')
    await render('```js\none two')
    expect(container.querySelector('[role=status]')!.textContent).toBe('')
    expect(write).toHaveBeenCalledTimes(2)
  })
  it('opens web links through Electron and toggles presentation without altering text', async () => {
    const text = '**bold** [web](https://example.com) [blocked](file:///secret)'
    await render(text)
    await act(async () => container.querySelector('a')!.click())
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com')
    expect(container.querySelectorAll('a')).toHaveLength(1)
    await render(text, 'en', false)
    expect(container.textContent).toBe(text)
    expect(container.querySelector('strong')).toBeNull()
    await render(text)
    expect(container.querySelector('strong')!.textContent).toBe('bold')
  })
})
