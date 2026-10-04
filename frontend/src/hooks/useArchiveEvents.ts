/**
 * 封存/草稿相关的跨标签页与页内事件。
 * - 同浏览器多标签页：用 storage 事件感知另一标签页的封存提交/草稿变动；
 * - 页内：用 BroadcastChannel（支持时）+ 本地订阅双通道。
 */
import type { ArchiveVersion } from '@/types'

export type ArchiveEventType =
  | 'sealed'
  | 'draft-opened'
  | 'draft-committed'
  | 'draft-discarded'
  | 'draft-updated'

export interface ArchiveEventPayload {
  trenchId: string
  draftId?: string
  version?: ArchiveVersion
  at: string
}

type Listener = (type: ArchiveEventType, payload: ArchiveEventPayload) => void

const CHANNEL = 'gbtrenchlog-archive'
const STORAGE_KEY = 'gbtrenchlog-archive-event'
const listeners = new Set<Listener>()

let channel: BroadcastChannel | null = null
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (event: MessageEvent<{ type: ArchiveEventType; payload: ArchiveEventPayload }>) => {
    listeners.forEach((listener) => listener(event.data.type, event.data.payload))
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      const data = JSON.parse(event.newValue) as { type: ArchiveEventType; payload: ArchiveEventPayload }
      listeners.forEach((listener) => listener(data.type, data.payload))
    } catch {
      // 忽略无法解析的事件
    }
  })
}

/** 派发封存/草稿事件（本标签页也会收到） */
export function emitArchiveEvent(type: ArchiveEventType, payload: Omit<ArchiveEventPayload, 'at'>): void {
  const full: ArchiveEventPayload = { ...payload, at: new Date().toISOString() }
  listeners.forEach((listener) => listener(type, full))
  channel?.postMessage({ type, payload: full })
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ type, payload: full }))
  }
}

/** 订阅事件，返回取消函数 */
export function onArchiveEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
