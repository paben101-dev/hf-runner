import { DEFAULT_TOOL_PREFERENCES, type ToolMessage, type ToolActivity } from '@shared/tools'
import { toToolContext, toolActivities } from '@shared/tool-history'
import { useEffect, useRef, useState, type DragEvent, type ClipboardEvent } from 'react'
import { formatCount } from '@shared/format'
import { getLang, L } from '@shared/i18n'
import { limitNotice, THINKING_MODES, thinkingParams, type ThinkingMode } from '@shared/thinking'
import { MAX_MAX_TOKENS, MAX_TOKEN_STOPS, MIN_MAX_TOKENS, nearestStopIndex, parseMaxTokens } from '@shared/tokens'
import { useApp } from '../App'
import { ConversationSidebar } from '../components/ConversationSidebar'
import { MessageBody } from '../components/MessageBody'
import { LoadProgressView } from '../components/LoadProgress'
import { api } from '../api'
import { conversationTitle, canContinueConversation, type Conversation, type ChatMessage as Message } from '@shared/conversations'

interface StreamChunk {
  error?: { message?: string } | string
  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }>
  usage?: { completion_tokens?: number; prompt_tokens?: number }
  timings?: { predicted_per_second?: number; predicted_n?: number; prompt_per_second?: number }
}

/** 添付画像の長辺の上限。画像トークン数と送信サイズを抑える */
const MAX_EDGE = 1536
const MAX_IMAGES = 8

/** 画像ファイルを縮小して data URL にする。PNG は透過を保つため PNG のまま、それ以外は JPEG */
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9)
}

/** OpenAI 互換 API に送る content。画像があれば text + image_url のパーツ配列にする */
function toApiContent(m: Message): string | Array<Record<string, unknown>> {
  if (!m.images?.length) return m.content
  return [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
}

export function ChatPage() {
  const app = useApp()
  const [messages, setMessages] = useState<Message[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [active, setActive] = useState<Conversation | null>(null)
  const attachmentEpoch = useRef(0)
  const pendingSave = useRef<Conversation | null>(null)
  const [busy, setBusy] = useState(true)
  const operation = useRef(false)
  const sessionRef = useRef<string | null>(null)
  const [rename, setRename] = useState<Conversation | null>(null)
  const [title, setTitle] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  const focusedRequest = useRef(0)
  const refresh = async () => setConversations(await api.conversations.list())
  const report = (e: unknown) => app.toast(String(e), 'error')
  useEffect(() => { void refresh().catch(report).finally(() => setBusy(false)) }, [])
  const select = async (id?: string) => {
    if (streaming || busy || operation.current) return
    operation.current = true
    setBusy(true)
    try {
      await ensureSaved()
      attachmentEpoch.current++
      const c = id ? await api.conversations.load(id) : null
      if (id && !c) throw new Error(L('会話を読み込めません', 'Could not load conversation'))
      setActive(c)
      setMessages(c?.messages ?? [])
      setInput('')
      setPending([])
      setRename(null)
      setFocusRequest((n) => n + 1)
    } catch (e) { report(e) } finally { operation.current = false; setBusy(false) }
  }
  const renameConversation = async () => {
    if (!rename || !title.trim() || streaming || busy || operation.current) return
    operation.current = true
    setBusy(true)
    try {
      await ensureSaved()
      await api.conversations.rename(rename.id, title)
      if (active?.id === rename.id) setActive({ ...active, title: title.trim() })
      setRename(null)
      await refresh()
    } catch (e) { report(e) } finally { operation.current = false; setBusy(false) }
  }
  const deleteConversation = async (target = active) => {
    if (!target || streaming || busy || operation.current) return
    operation.current = true
    setBusy(true)
    try {
      await ensureSaved()
      const deleted = await api.conversations.delete(target.id)
      if (!deleted) return
      if (active?.id === target.id) {
        attachmentEpoch.current++
        setActive(null)
        setMessages([])
        setInput('')
        setPending([])
      }
      if (rename?.id === target.id) setRename(null)
      await refresh()
    } catch (e) { report(e) } finally {
      operation.current = false
      setBusy(false)
      setFocusRequest((n) => n + 1)
    }
  }
  const persist = async (c: Conversation, next: Message[]) => {
    const saved = { ...c, messages: next, updatedAt: Date.now() }
    // Keep identity/model association even if the first save fails.
    setActive(saved)
    pendingSave.current = saved
    await api.conversations.save(saved)
    pendingSave.current = null
    // A sidebar refresh failure does not mean the messages failed to save.
    await refresh().catch(report)
  }
  const ensureSaved = async () => {
    if (pendingSave.current) await persist(pendingSave.current, pendingSave.current.messages)
  }
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const [showParams, setShowParams] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const s = app.server
  const modelMatches = canContinueConversation(active, s.modelId)
  const ready = s.state === 'running' && s.port && modelMatches && !busy
  const vision = !!ready && !!s.vision

  useEffect(() => {
    // Wait for React to re-enable the composer after the IPC operation finishes.
    if (focusRequest === focusedRequest.current || !ready || rename || app.page !== 'chat') return
    composerRef.current?.focus()
    focusedRequest.current = focusRequest
  }, [focusRequest, ready, rename, app.page])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  // モデルが変わったら添付をクリア(画像非対応モデルに送らないため)
  useEffect(() => {
    attachmentEpoch.current++
    setPending([])
  }, [s.modelId])

  const addFiles = async (files: Iterable<File>) => {
    if (operation.current || streaming || busy || rename) return
    const images = [...files].filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    if (!vision) {
      app.toast(
        L(
          'このモデルは画像入力に対応していません(GGUF は mmproj 付き、safetensors は視覚言語モデルが必要です)',
          'This model does not support image input (GGUF needs an mmproj file; safetensors needs a vision-language model)',
        ),
        'error',
      )
      return
    }
    const epoch = attachmentEpoch.current
    try {
      const urls = await Promise.all(images.slice(0, MAX_IMAGES).map(fileToDataUrl))
      if (attachmentEpoch.current === epoch) setPending((prev) => [...prev, ...urls].slice(0, MAX_IMAGES))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      app.toast(L(`画像を読み込めません: ${msg}`, `Could not load the image: ${msg}`), 'error')
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    void addFiles(e.dataTransfer.files)
  }

  const send = async () => {
    if (rename) return
    const text = input.trim()
    if ((!text && pending.length === 0) || !ready || streaming || operation.current) return
    operation.current = true
    attachmentEpoch.current++
    setInput('')
    const images = pending
    setPending([])
    const history: Message[] = [...messages, { role: 'user', content: text, images: images.length ? images : undefined }]
    const conversation: Conversation = active ?? {
      id: crypto.randomUUID(), title: conversationTitle(history), createdAt: Date.now(), updatedAt: Date.now(),
      modelId: s.modelId, modelName: s.modelName, messages: [],
    }
    setMessages([...history, { role: 'assistant', content: '', thinking: true }])
    setStreaming(true)
    const controller = new AbortController()
    abortRef.current = controller
    if (app.settings?.tools?.enabled || messages.some((m) => m.toolMessages?.length)) {
      const id = crypto.randomUUID()
      sessionRef.current = id
      let context: ToolMessage[] = []
      const activities = new Map<string, ToolActivity>()
      let content = '', reasoning = ''
      let stats: string | undefined
      let toolMessages: ToolMessage[] | undefined
      let started = false
      let reasoningStartedAt: number | undefined
      const update = (done = false) => { if (sessionRef.current !== id) return; setMessages([...history, { role: 'assistant', content, reasoning: reasoning || undefined, thinking: !done && !content, stats, reasoningStartedAt, reasoningMs: reasoningStartedAt ? Date.now() - reasoningStartedAt : undefined, activities: [...activities.values()], toolMessages }]) }
      const off = api.tools.onEvent((event) => {
        if (event.id !== id) return
        if (event.content !== undefined) content = event.content
        if (event.reasoning !== undefined) { reasoning = event.reasoning; if (reasoning) reasoningStartedAt ??= Date.now() }
        if (event.activity) activities.set(event.activity.call.id, event.activity)
        update()
      })
      const cancel = () => { void api.tools.cancel(id) }
      controller.signal.addEventListener('abort', cancel, { once: true })
      try {
        context = toToolContext(history)
        await persist(conversation, history)
        controller.signal.throwIfAborted()
        started = true
        const result = await api.tools.start({ id, modelId: s.modelId!, messages: context })
        if (sessionRef.current === id) toolMessages = result.messages.slice(context.length)
        content = result.content
        reasoning = result.reasoning
        const seconds = (result.elapsedMs / 1000).toFixed(1)
        stats = result.completionTokens !== undefined ? L(`${result.completionTokens} トークン · ${seconds} 秒`, `${result.completionTokens} tokens · ${seconds}s`) : L(`${seconds} 秒`, `${seconds}s`)
        if (result.error) content += `\n\n⚠ ${result.error}`
      } catch (e) {
        if (!started && !controller.signal.aborted) report(e)
        content += controller.signal.aborted ? L('\n\n(停止しました)', '\n\n(Stopped)') : `\n\n⚠ ${e instanceof Error ? e.message : String(e)}`

      } finally {
        if (started) {
          update(true)
          await persist(conversation, [...history, { role: 'assistant', content, reasoning: reasoning || undefined, stats, toolMessages }]).catch(report)
        } else { setMessages(history) }
        off()
        controller.signal.removeEventListener('abort', cancel)
        abortRef.current = null
        sessionRef.current = null
        operation.current = false
        setStreaming(false)
      }
      return
    }
    const t0 = performance.now()
    let content = ''
    let reasoning = ''
    let tokens = 0
    let tps: number | undefined
    let reasonStart: number | undefined
    let reasonEnd: number | undefined
    let finish: string | null | undefined
    const maxTokens = app.settings?.maxTokens ?? 2048
    let finalStats: string | undefined
    let failure: string | undefined
    let requestStarted = false
    const flush = (done = false) =>
      setMessages((prev) => {
        const next = [...prev]
        const reasoningMs = reasonStart !== undefined ? (reasonEnd ?? Date.now()) - reasonStart : undefined
        next[next.length - 1] = { role: 'assistant', content, reasoning: reasoning || undefined, thinking: !done && !content, reasoningStartedAt: reasonStart, reasoningMs }
        return next
      })
    try {
      await persist(conversation, history)
      requestStarted = true
      const body = {
        messages: [
          ...(app.settings?.systemPrompt?.trim() ? [{ role: 'system', content: app.settings.systemPrompt }] : []),
          ...history.map((m) => ({ role: m.role, content: toApiContent(m) })),
        ],
        stream: true,
        temperature: app.settings?.temperature ?? 0.7,
        max_tokens: maxTokens,
        stream_options: { include_usage: true },
        // 思考の量 (思考の上限トークン数・思考のオン/オフ)。標準では何も足さない
        ...thinkingParams(app.settings?.thinkingMode),
      }
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const detail = await res.text()
        throw new Error(L(`サーバーエラー (HTTP ${res.status}): ${detail}`, `Server error (HTTP ${res.status}): ${detail}`))
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let lastFlush = 0
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') break outer
            let chunk: StreamChunk
            try {
              chunk = JSON.parse(data) as StreamChunk
            } catch {
              continue
            }
            if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? L('生成エラー', 'Generation error')))
            const delta = chunk.choices?.[0]?.delta
            if (delta?.reasoning_content) {
              reasoning += delta.reasoning_content
              reasonStart ??= Date.now()
            }
            if (delta?.content) {
              if (reasonStart !== undefined && reasonEnd === undefined) reasonEnd = Date.now()
              content += delta.content
              tokens++
            }
            if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason
            if (chunk.usage?.completion_tokens) tokens = chunk.usage.completion_tokens
            if (chunk.timings?.predicted_per_second) tps = chunk.timings.predicted_per_second
          }
          const now = performance.now()
          if (now - lastFlush > 40) {
            lastFlush = now
            flush()
          }
        }
      }
      flush(true)
      const sec = (performance.now() - t0) / 1000
      const rate = tps ?? tokens / Math.max(sec, 0.001)
      finalStats = L(`${tokens} トークン · ${rate.toFixed(1)} tok/s · ${sec.toFixed(1)} 秒`, `${tokens} tokens · ${rate.toFixed(1)} tok/s · ${sec.toFixed(1)}s`)
    } catch (e) {
      if (!requestStarted) report(e)
      if (!controller.signal.aborted) failure = e instanceof Error ? e.message : String(e)
    } finally {
      const interrupted = controller.signal.aborted
      const response: Message = { role: 'assistant', content: content + (interrupted ? L('\n\n(停止しました)', '\n\n(Stopped)') : failure ? `\n\n⚠ ${failure}` : ''), stats: finalStats, reasoning: reasoning || undefined,
        reasoningMs: reasonStart !== undefined ? (reasonEnd ?? Date.now()) - reasonStart : undefined,
        notice: finish === 'length' ? limitNotice(!!content.trim(), !!reasoning, tokens >= maxTokens, maxTokens, s.contextSize) : undefined }
      const next = requestStarted ? [...history, response] : history
      setMessages(next)
      if (requestStarted) await persist(conversation, next).catch(report)
      operation.current = false
      setStreaming(false)
      abortRef.current = null
    }
  }

  return (
    <div className="chat-layout">
      <ConversationSidebar conversations={conversations} activeId={active?.id} disabled={streaming || busy}
        onSelect={(id) => void select(id)} onNew={() => void select()}
        onRename={(c) => {
          if (operation.current || streaming || busy) return
          setTitle(c.title)
          setRename(c)
        }}
        onDelete={(c) => void deleteConversation(c)} onError={report} />
    <div className="page chat-page" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {(active || rename) && <div className="conversation-actions">
        {rename ? <form onSubmit={(e) => { e.preventDefault(); void renameConversation() }}>
          <input aria-label={L('会話名', 'Conversation title')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} autoFocus />
          <button disabled={busy}>{L('保存', 'Save')}</button><button type="button" onClick={() => setRename(null)}>{L('キャンセル', 'Cancel')}</button>
        </form> : <><strong>{active?.title}</strong><button disabled={streaming || busy} onClick={() => { if (active) { setTitle(active.title); setRename(active) } }}>{L('名前を変更', 'Rename')}</button>
        <button className="danger" disabled={streaming || busy} onClick={() => void deleteConversation()}>{L('削除', 'Delete')}</button></>}
      </div>}
      {!modelMatches && <div className="notice warn">{L(`この会話のモデル: ${active?.modelName}。ライブラリから同じモデルを起動するか、新しい会話を作成してください。`, `Conversation model: ${active?.modelName}. Launch the same model from the Library or create a new chat.`)}</div>}
      <div className="chat-head">
        <div>
          {ready ? (
            <>
              <span className="status-dot ok" /> <strong>{s.modelName}</strong>
              <span className="muted small">
                {' '}
                · ctx {formatCount(s.contextSize)}
                {s.gpuLayers !== undefined && L(` · GPU レイヤー ${s.gpuLayers}`, ` · GPU layers ${s.gpuLayers}`)}
                {s.engine === 'transformers' && ` · Transformers (${s.precision ?? 'auto'})`}
                {vision && L(' · 画像入力可', ' · Image input')}
              </span>
            </>
          ) : s.state === 'starting' ? (
            <>
              <span className="status-dot warn" /> {L(`${s.modelName} を読み込み中…`, `Loading ${s.modelName}…`)}
            </>
          ) : (
            <span className="muted">{L('モデルが起動していません。', 'No model is running.')}</span>
          )}
        </div>
        <div className="chat-head-actions">
          <button className="ghost small" onClick={() => setShowParams((v) => !v)}>
            {showParams ? L('パラメータを隠す', 'Hide parameters') : L('パラメータ', 'Parameters')}
          </button>
          <button className="ghost small" onClick={() => void select()} disabled={streaming || busy || messages.length === 0}>
            {L('会話をクリア', 'Clear chat')}
          </button>
          {!ready && s.state !== 'starting' && (
            <button className="primary small" onClick={() => app.setPage('library')}>
              {L('ライブラリからモデルを起動', 'Launch a model from the Library')}
            </button>
          )}
        </div>
      </div>

      {s.state === 'starting' && (
        <div className="chat-loading">
          <LoadProgressView progress={s.progress} />
        </div>
      )}

      <div className="tool-chat-controls">
        <label><input type="checkbox" checked={app.settings?.tools?.enabled ?? false} disabled={streaming}
          onChange={(e) => app.updateSettings({ tools: { ...(app.settings?.tools ?? DEFAULT_TOOL_PREFERENCES), enabled: e.target.checked } })} /> {L('ツールを使用', 'Use tools')}</label>
        <span className="muted small">{L('対応モデル・テンプレートが必要です。設定でツールを管理できます。', 'Requires a compatible model/template. Manage tools in Settings.')}</span>
      </div>

      {showParams && app.settings && (
        <div className="params">
          <label>
            {L('システムプロンプト', 'System prompt')}
            <textarea
              rows={2}
              value={app.settings.systemPrompt}
              onChange={(e) => app.updateSettings({ systemPrompt: e.target.value })}
              placeholder={L('例: あなたは親切な日本語アシスタントです。', 'e.g. You are a helpful assistant.')}
            />
          </label>
          <label>
            {L('温度', 'Temperature')} {app.settings.temperature.toFixed(2)}
            <input type="range" min={0} max={2} step={0.05} value={app.settings.temperature} onChange={(e) => app.updateSettings({ temperature: Number(e.target.value) })} />
          </label>
          <MaxTokensField value={app.settings.maxTokens} contextSize={s.contextSize ?? app.settings.contextSize} onChange={(maxTokens) => app.updateSettings({ maxTokens })} />
          <label title={L('Qwen3・DeepSeek-R1・gpt-oss など、回答の前に考えるモデルで効きます。短くするほど回答が早く出ますが、難しい質問の正確さは下がることがあります', 'Applies to models that think before answering (Qwen3, DeepSeek-R1, gpt-oss, …). Shorter thinking answers sooner but may be less accurate on hard questions')}>
            {L('思考', 'Thinking')}
            <select value={app.settings.thinkingMode ?? 'standard'} onChange={(e) => app.updateSettings({ thinkingMode: e.target.value as ThinkingMode })}>
              {THINKING_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label()}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-icon">💬</div>
            <p>
              {ready
                ? vision
                  ? L(
                      'メッセージを入力して送信してください。画像は貼り付け・ドロップ・🖼 ボタンで添付できます。',
                      'Type a message and send it. You can attach images by pasting, dropping, or using the 🖼 button.',
                    )
                  : L('メッセージを入力して送信してください。', 'Type a message and send it.')
                : L('モデルを起動するとここでチャットできます。', 'Launch a model to chat here.')}
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.reasoning && (
              <details className="reasoning">
                <summary>
                  {m.thinking ? (
                    <>
                      <span className="spinner" /> {L('思考中…', 'Thinking…')} <ThinkingSeconds since={m.reasoningStartedAt} />
                      {L(' 秒', 's')}
                    </>
                  ) : (
                    L('思考過程', 'Reasoning') +
                    (m.reasoningMs !== undefined ? L(` (${Math.round(m.reasoningMs / 1000)} 秒)`, ` (${Math.round(m.reasoningMs / 1000)}s)`) : '')
                  )}
                </summary>
                <div className="pre">{m.reasoning}</div>
              </details>
            )}
            {m.thinking && m.reasoning && <div className="think-preview muted small">{lastLine(m.reasoning)}</div>}
            {m.thinking && !m.reasoning && (
              <div className="typing" aria-label={L('応答を待っています', 'Waiting for a response')}>
                <span />
                <span />
                <span />
              </div>
            )}
            {m.images && m.images.length > 0 && (
              <div className="msg-images">
                {m.images.map((src, j) => (
                  <img key={j} src={src} alt="" />
                ))}
              </div>
            )}
            {(m.activities ?? toolActivities(m.toolMessages)).map((activity) => <details className="tool-activity" key={activity.call.id}>
              <summary>{activity.call.function.name} · {activity.state === 'running' ? L('実行中…', 'Executing…') : activity.state === 'requested' ? L('要求', 'Requested') : activity.result?.ok ? L('完了', 'Done') : L('エラー', 'Error')}</summary>
              <div className="pre">{activity.call.function.arguments}</div>
              {activity.result && <div className="pre">{JSON.stringify(activity.result, null, 2)}</div>}
            </details>)}
            <MessageBody text={m.content} markdown={app.settings?.renderMarkdown ?? true} language={getLang()} />
            {m.notice && <div className="notice small warn msg-notice">⚠ {m.notice}</div>}
            {m.stats && <div className="msg-stats muted small">{m.stats}</div>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {pending.length > 0 && (
        <div className="attach-strip">
          {pending.map((src, i) => (
            <div key={i} className="thumb">
              <img src={src} alt="" />
              <button type="button" className="ghost" title={L('外す', 'Remove')} onClick={() => setPending((p) => p.filter((_, k) => k !== i))}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(e.target.files ?? [])
            e.target.value = ''
          }}
        />
        <button
          type="button"
          className="ghost attach"
          onClick={() => fileRef.current?.click()}
          disabled={!ready || !vision || streaming || !!rename}
          title={vision ? L('画像を添付(貼り付け・ドロップも可)', 'Attach images (you can also paste or drop them)') : L('このモデルは画像入力に対応していません', 'This model does not support image input')}
        >
          🖼
        </button>
        <textarea
          ref={composerRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={
            ready
              ? vision
                ? L('メッセージを入力 (Enter で送信、Shift+Enter で改行、画像は貼り付け可)', 'Type a message (Enter to send, Shift+Enter for a new line, paste images)')
                : L('メッセージを入力 (Enter で送信、Shift+Enter で改行)', 'Type a message (Enter to send, Shift+Enter for a new line)')
              : L('モデルを起動してください', 'Launch a model first')
          }
          disabled={!ready || !!rename}
          rows={2}
        />
        {streaming ? (
          <button type="button" className="danger" onClick={() => abortRef.current?.abort()}>
            {L('■ 停止', '■ Stop')}
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!ready || !!rename || (!input.trim() && pending.length === 0)}>
            {L('送信', 'Send')}
          </button>
        )}
      </form>
    </div>
    </div>
  )
}

/**
 * 最大出力トークン。スライドバーはよく使う値 (MAX_TOKEN_STOPS) に吸い付き、それ以外は横の欄に手で入れる。
 * 手入力は入力中に値を補正しない (「1」を打った時点で下限に直されると「1000」が打てない) よう、欄から離れたとき・Enter で反映する
 */
function MaxTokensField({ value, contextSize, onChange }: { value: number; contextSize?: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const v = parseMaxTokens(text)
    if (v === null) setText(String(value))
    else if (v !== value) onChange(v)
    else setText(String(value))
  }
  return (
    <div className="params-field">
      <span>
        {L('最大出力トークン', 'Max output tokens')} {value.toLocaleString()}
      </span>
      <div className="slider-with-input">
        <input
          type="range"
          min={0}
          max={MAX_TOKEN_STOPS.length - 1}
          step={1}
          list="max-token-stops"
          value={nearestStopIndex(value)}
          onChange={(e) => onChange(MAX_TOKEN_STOPS[Number(e.target.value)])}
          aria-label={L('最大出力トークン (よく使う値)', 'Max output tokens (common values)')}
        />
        <datalist id="max-token-stops">
          {MAX_TOKEN_STOPS.map((_, i) => (
            <option key={i} value={i} />
          ))}
        </datalist>
        <input
          type="number"
          min={MIN_MAX_TOKENS}
          max={MAX_MAX_TOKENS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          aria-label={L('最大出力トークン (手入力)', 'Max output tokens (manual)')}
        />
      </div>
      {contextSize !== undefined && value > contextSize && (
        <span className="small">
          {L(`コンテキスト長 (${contextSize.toLocaleString()}) を超える分は使われません`, `Anything beyond the context length (${contextSize.toLocaleString()}) is not used`)}
        </span>
      )}
    </div>
  )
}

/** 思考中の経過秒数。0.5 秒ごとにこの表示だけを更新する (メッセージ一覧全体は再描画しない) */
function ThinkingSeconds({ since }: { since?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  return <>{Math.max(0, Math.round((now - (since ?? now)) / 1000))}</>
}

/** 思考中に流し表示する直近の 1 行 (長ければ末尾 120 文字) */
function lastLine(text: string): string {
  const line = text.trimEnd().split('\n').pop() ?? ''
  return line.length > 120 ? `…${line.slice(-120)}` : line
}
