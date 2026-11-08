import { useRef, useState } from 'react'
import type { Conversation } from '@shared/conversations'
import { L } from '@shared/i18n'
import { api } from '../api'

const MIN_WIDTH = 160
const MAX_WIDTH = 420
const WIDTH_KEY = 'hfrunner.conversationSidebarWidth'
const clampWidth = (width: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width))

function initialWidth(): number {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY))
    return width > 0 && Number.isFinite(width) ? clampWidth(width) : 200
  } catch { return 200 }
}

interface Props {
  conversations: Conversation[]
  activeId?: string
  disabled: boolean
  onSelect(id: string): void
  onNew(): void
  onRename(c: Conversation): void
  onDelete(c: Conversation): void
  onError(e: unknown): void
}

export function ConversationSidebar({ conversations, activeId, disabled, onSelect, onNew, onRename, onDelete, onError }: Props) {
  const [open, setOpen] = useState(true)
  const [width, setWidth] = useState(initialWidth)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const remember = (next: number) => {
    try { localStorage.setItem(WIDTH_KEY, String(next)) } catch { /* Optional UI preference. */ }
  }
  const contextMenu = async (conversation: Conversation) => {
    if (disabled) return
    try {
      const action = await api.conversations.menu()
      if (action === 'rename') onRename(conversation)
      if (action === 'delete') onDelete(conversation)
    } catch (e) { onError(e) }
  }

  return <>
    <aside className={`conversation-sidebar ${open ? '' : 'collapsed'}`} style={open ? { width } : undefined}>
      <button className="ghost small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '◀' : '▶'} {L('履歴', 'History')}
      </button>
      {open && <>
        <button disabled={disabled} onClick={onNew}>{L('新しい会話', 'New Chat')}</button>
        <div className="conversation-list">
          {conversations.map((c) => <button key={c.id} className={`ghost ${activeId === c.id ? 'active' : ''}`}
            aria-current={activeId === c.id ? 'true' : undefined} disabled={disabled} onClick={() => onSelect(c.id)}
            onContextMenu={(e) => { e.preventDefault(); void contextMenu(c) }}
            onKeyDown={(e) => {
              if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                e.preventDefault()
                void contextMenu(c)
              }
            }}>
            <strong>{c.title}</strong><span className="muted small">{c.modelName}</span>
          </button>)}
        </div>
      </>}
    </aside>
    {open && <div className="conversation-divider" role="separator" aria-orientation="vertical"
      aria-label={L('履歴の幅を変更', 'Resize conversation history')} tabIndex={0}
      aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        drag.current = { x: e.clientX, width: e.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? width }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (drag.current) setWidth(clampWidth(drag.current.width + e.clientX - drag.current.x))
      }}
      onPointerUp={(e) => {
        if (!drag.current) return
        const next = clampWidth(drag.current.width + e.clientX - drag.current.x)
        setWidth(next)
        remember(next)
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={(e) => {
        const next = e.key === 'ArrowLeft' ? width - 10 : e.key === 'ArrowRight' ? width + 10
          : e.key === 'Home' ? MIN_WIDTH : e.key === 'End' ? MAX_WIDTH : undefined
        if (next === undefined) return
        e.preventDefault()
        setWidth(clampWidth(next))
        remember(clampWidth(next))
      }} />}
  </>
}
