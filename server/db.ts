// Supabase 持久化：各聊天室的對話流程（rooms / messages）與 FAQ 存在 Supabase。
// 未設定 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 時回傳 null，上層退回 JSON 檔儲存。

import type { ChatMessage, FaqEntry } from '../shared/protocol'
import { MAX_MESSAGES_PER_ROOM } from '../shared/protocol'

export interface SupabaseConfig {
  url: string
  key: string
}

export interface ChatRoomRow {
  id: string
  name: string
  ownerId: string | null
  ownerName: string | null
  expiresAt: number | null
  botEnabled: boolean
}

export interface ChatRoomState extends ChatRoomRow {
  messages: ChatMessage[]
}

export function loadSupabaseConfig(): SupabaseConfig | null {
  const url = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return { url, key }
}

interface DbRoomRow {
  id: string
  name: string
  owner_id: string | null
  owner_name: string | null
  expires_at: number | null
  bot_enabled: boolean
}

interface DbMessageRow {
  id: string
  room_id: string
  kind: string
  sender_id: string
  sender_name: string
  color: string
  text: string
  ts: number
}

function roomToRow(room: ChatRoomRow) {
  return {
    id: room.id,
    name: room.name,
    owner_id: room.ownerId,
    owner_name: room.ownerName,
    expires_at: room.expiresAt,
    bot_enabled: room.botEnabled,
  }
}

function messageToRow(message: ChatMessage) {
  return {
    id: message.id,
    room_id: message.roomId,
    kind: message.kind,
    sender_id: message.senderId,
    sender_name: message.senderName,
    color: message.color,
    text: message.text,
    ts: message.ts,
  }
}

class SupabaseStore {
  private config: SupabaseConfig

  constructor(config: SupabaseConfig) {
    this.config = config
  }

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    try {
      const response = await fetch(`${this.config.url}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: this.config.key,
          Authorization: `Bearer ${this.config.key}`,
          'Content-Type': 'application/json',
          // upsert 時要求 PostgREST 依主鍵去重合併
          ...(method === 'POST' && body ? { Prefer: 'resolution=merge-duplicates,return=minimal' } : { Prefer: 'return=minimal' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`${method} ${path} → HTTP ${response.status} ${detail.slice(0, 200)}`)
      }
      if (method === 'GET') return (await response.json()) as T
      return null
    } catch (error) {
      console.error('[chat] Supabase 儲存失敗', error instanceof Error ? error.message : error)
      return null
    }
  }

  /** 從 Supabase 讀取初始狀態（房間、每房的訊息尾端、FAQ） */
  async loadState(): Promise<{ rooms: ChatRoomState[]; faqs: FaqEntry[] } | null> {
    const roomRows = await this.rest<DbRoomRow[]>('GET', 'chat_rooms?select=*')
    if (!roomRows) return null
    const messageRows =
      (await this.rest<DbMessageRow[]>(
        `GET`,
        // 只取每間房最新的訊息即可：全撈再依房切尾
        `chat_messages?select=*&order=ts.asc&limit=${MAX_MESSAGES_PER_ROOM * 100}`,
      )) ?? []
    const faqRows = await this.rest<Array<{ keyword: string; answer: string }>>('GET', 'chat_faqs?select=*')

    const rooms: ChatRoomState[] = roomRows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      expiresAt: row.expires_at,
      botEnabled: row.bot_enabled,
      messages: [],
    }))
    const roomById = new Map(rooms.map((room) => [room.id, room]))
    for (const row of messageRows) {
      const room = roomById.get(row.room_id)
      if (!room) continue
      room.messages.push({
        id: row.id,
        roomId: row.room_id,
        kind: row.kind === 'system' ? 'system' : 'chat',
        senderId: row.sender_id,
        senderName: row.sender_name,
        color: row.color,
        text: row.text,
        ts: Number(row.ts),
      })
    }
    // 每房只保留最新的訊息（記憶體上限邏輯與原本一致）
    for (const room of rooms) {
      if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
        room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM)
      }
    }
    return {
      rooms,
      faqs: (faqRows ?? []).map((row) => ({ keyword: row.keyword, answer: row.answer })),
    }
  }

  /** 新增或更新房間資料（建立房間、機器人開關等） */
  async upsertRoom(room: ChatRoomRow): Promise<void> {
    await this.rest('POST', 'chat_rooms', [roomToRow(room)])
  }

  /** 刪除房間（訊息會因外鍵 cascade 一併刪除） */
  async deleteRoom(roomId: string): Promise<void> {
    await this.rest('DELETE', `chat_rooms?id=eq.${encodeURIComponent(roomId)}`)
  }

  /** 新增一則訊息（含系統訊息；id 重複時合併寫入，具幂等性） */
  async insertMessage(message: ChatMessage): Promise<void> {
    await this.rest('POST', 'chat_messages', [messageToRow(message)])
  }

  /** 儲存一條 FAQ（/教） */
  async upsertFaq(entry: FaqEntry): Promise<void> {
    await this.rest('POST', 'chat_faqs?on_conflict=keyword', [
      { keyword: entry.keyword, answer: entry.answer, updated_at: new Date().toISOString() },
    ])
  }

  /** 刪除一條 FAQ（/忘） */
  async deleteFaq(keyword: string): Promise<void> {
    await this.rest('DELETE', `chat_faqs?keyword=eq.${encodeURIComponent(keyword)}`)
  }
}

export function createSupabaseStore(config: SupabaseConfig): SupabaseStore {
  return new SupabaseStore(config)
}
