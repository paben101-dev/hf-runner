export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** Raw protocol messages for this assistant turn, including paired tool results. */
  toolMessages?: import('./tools').ToolMessage[]
  /** Ephemeral streaming activity; restored activity is derived from toolMessages. */
  activities?: import('./tools').ToolActivity[]
  /** 添付画像 (data URL) */
  images?: string[]
  reasoning?: string
  stats?: string
  /** 生成中で、まだ本文が届いていない (応答待ち or 思考中) */
  thinking?: boolean
  /** 思考 (reasoning_content) が始まった時刻 (Date.now) */
  reasoningStartedAt?: number
  /** 思考にかかった時間。本文が始まった、または生成が終わった時点で確定 */
  reasoningMs?: number
  /** 上限に達して止まったときの説明 (回答が出なかった・途中で終わった) */
  notice?: string
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  modelId?: string
  modelName?: string
  messages: ChatMessage[]
}

export function conversationTitle(messages: ChatMessage[]): string {
  return messages.find((m) => m.role === 'user')?.content.trim().replace(/\s+/g, ' ').slice(0, 80) || '💬'
}

export function canContinueConversation(conversation: Conversation | null, modelId?: string): boolean {
  return !conversation?.modelId || conversation.modelId === modelId
}
