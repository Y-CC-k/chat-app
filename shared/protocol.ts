// 共用的 WebSocket 傳輸協定型別（前端與後端共用）

export interface ChatMessage {
  id: string
  roomId: string
  /** chat = 一般訊息；system = 系統提示（加入／離開等） */
  kind: 'chat' | 'system'
  senderId: string
  senderName: string
  color: string
  text: string
  ts: number
}

export interface MemberInfo {
  userId: string
  nickname: string
  color: string
  /** 正在輸入中（僅在 rooms 廣播裡帶出） */
  typing?: boolean
}

export interface RoomSummary {
  id: string
  name: string
  /** null = 內建房間（大廳） */
  ownerId: string | null
  members: MemberInfo[]
  lastMessage: { text: string; ts: number; senderName: string } | null
  /** 是否啟用機器人自動答詢 */
  botEnabled: boolean
  /** 逾時解散時間（null = 永久存在，僅大廳） */
  expiresAt: number | null
}

export interface ServerUser {
  userId: string
  nickname: string
  color: string
}

// ── Client → Server ──────────────────────────────────────────────

export type ClientMsg =
  | { type: 'hello'; nickname: string; color?: string; /** widget 訪客不進大廳：大廳訊息不流入外掛 */ skipLobby?: boolean }
  | { type: 'chat'; roomId: string; text: string }
  | { type: 'typing'; roomId: string; typing: boolean }
  | { type: 'room:create'; name: string }
  | { type: 'room:join'; roomId: string }
  | { type: 'room:leave'; roomId: string }
  | { type: 'bot'; roomId: string; enabled: boolean }
  | { type: 'tutor'; enabled: boolean }

// ── Server → Client ──────────────────────────────────────────────

export type ServerMsg =
  | { type: 'welcome'; user: ServerUser }
  | { type: 'rooms'; rooms: RoomSummary[] }
  | { type: 'joined'; roomId: string; messages: ChatMessage[] }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'typing'; roomId: string; userId: string; nickname: string; typing: boolean }
  | { type: 'audio'; roomId: string; messageId: string; data: string; voice: 'en' | 'zh' }
  | { type: 'room:closed'; roomId: string; reason: string }
  | { type: 'error'; message: string }

/** 每一間房保留的訊息上限 */
export const MAX_MESSAGES_PER_ROOM = 300

/** 暱稱長度上限 */
export const MAX_NICKNAME_LENGTH = 24

/** 訊息文字長度上限 */
export const MAX_TEXT_LENGTH = 2000

/** 房間名稱長度上限 */
export const MAX_ROOM_NAME_LENGTH = 30

/** 自建聊天室最長存活時間（1 小時） */
export const ROOM_LIFETIME_MS = 60 * 60 * 1000

/** 每位使用者可同時建立的聊天室數量（大廳不算） */
export const MAX_ROOMS_PER_USER = 1

/** 對話紀錄保留時間：14 天（超過的訊息定時從 Supabase 清掉） */
export const MESSAGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** 對話呈現範圍：只顯示最近 24 小時內的訊息 */
export const MESSAGE_VISIBILITY_MS = 24 * 60 * 60 * 1000

/** 使用者頭像預設色票 */
export const AVATAR_COLORS = [
  '#06c755',
  '#3b82f6',
  '#f97316',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
  '#ef4444',
  '#eab308',
] as const

/** 內建大廳 ID */
export const LOBBY_ID = 'lobby'

/** 內建機器人 */
export const BOT_USER_ID = 'bot-helper'
export const BOT_NICKNAME = '小幫手'
export const BOT_COLOR = '#8b5cf6'

/** 內建英文教室 ID：永遠存在、唯一具備朗讀／自動翻譯功能的房間 */
export const ENGLISH_ROOM_ID = 'english-room'

/** 內建英文助教機器人（中文→英文翻譯與朗讀） */
export const BOT_EN_USER_ID = 'bot-en-tutor'
export const BOT_EN_NICKNAME = '英文助教'
export const BOT_EN_COLOR = '#3b82f6'

/** 單則自訂 FAQ */
export interface FaqEntry {
  keyword: string
  answer: string
}
