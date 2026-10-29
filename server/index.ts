import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  WebSocketServer,
  type WebSocket,
} from 'ws'
import {
  AVATAR_COLORS,
  BOT_COLOR,
  BOT_EN_COLOR,
  BOT_EN_NICKNAME,
  BOT_EN_USER_ID,
  BOT_NICKNAME,
  BOT_USER_ID,
  LOBBY_ID,
  MAX_MESSAGES_PER_ROOM,
  MAX_NICKNAME_LENGTH,
  MAX_ROOMS_PER_USER,
  MAX_ROOM_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  ROOM_LIFETIME_MS,
  MESSAGE_RETENTION_MS,
  MESSAGE_VISIBILITY_MS,
  type ChatMessage,
  type ClientMsg,
  type FaqEntry,
  type MemberInfo,
  type RoomSummary,
  type ServerMsg,
} from '../shared/protocol'
import {
  commandReply,
  extractTutorQuery,
  fallbackReply,
  greetingReply,
  isBotMention,
  isQuestion,
  isTutorMention,
  matchFaq,
  parseCommand,
  translateText,
  tutorIntro,
  isMostlyChinese,
  type Command,
} from './bot'
import { HELPER_SYSTEM_PROMPT, llmChat, loadLlmConfig } from './llm'
import { synthesize } from './tts'
import { createSupabaseStore, loadSupabaseConfig, type ChatRoomRow } from './db'
import { loadBlockedWords, maskSensitiveWords } from './moderation'

// ── 型別 ──────────────────────────────────────────────────────────

interface UserConn {
  socket: WebSocket
  userId: string
  nickname: string
  color: string
  alive: boolean
  /** 已進入英文教室：自己的訊息自動翻譯 */
  tutorMode: boolean
}

interface Room {
  id: string
  name: string
  ownerId: string | null
  /** 建立者暱稱（重連後 userId 會改變，用暱稱維持限額） */
  ownerName: string | null
  /** 逾時解散時間；null = 永久（僅大廳） */
  expiresAt: number | null
  messages: ChatMessage[]
  members: Map<string, UserConn>
  botEnabled: boolean
}

interface PersistedRoom {
  id: string
  name: string
  ownerId: string | null
  ownerName: string | null
  expiresAt: number | null
  messages: ChatMessage[]
  botEnabled: boolean
}

interface PersistedStore {
  rooms: PersistedRoom[]
  faqs: FaqEntry[]
}

// ── 常數與工具 ────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 埠：本地可用 CHAT_PORT 覆寫；正式環境（Render 等）會注入 PORT
const PORT = Number(process.env.CHAT_PORT ?? process.env.PORT ?? 4001)
const DATA_DIR = path.join(__dirname, 'data')
const DATA_FILE = path.join(DATA_DIR, 'store.json')
/** 正式部署時發送的前端靜態檔（npm run build 產出） */
const DIST_DIR = path.join(__dirname, '..', 'dist')
const HEARTBEAT_MS = 30_000
// ── .env 檔載入（零相依；正式環境變數優先） ──────────────────────

try {
  const raw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
} catch {
  // 沒有 .env 檔：只用系統環境變數
}

/** 自建聊天室存活時間（可用環境變數縮短以利測試；正式為 1 小時） */
const ROOM_LIFETIME = Number(process.env.CHAT_ROOM_LIFETIME_MS) || ROOM_LIFETIME_MS

/** 對話呈現範圍（預設 24 小時）與保留期（預設 14 天） */
const VISIBILITY_WINDOW = Number(process.env.CHAT_VISIBILITY_MS) || MESSAGE_VISIBILITY_MS
const RETENTION = Number(process.env.CHAT_RETENTION_MS) || MESSAGE_RETENTION_MS
const BLOCKED_WORDS = loadBlockedWords()

/** 呈現用的訊息：只取最近一段時間（預設 24 小時）內的 */
function displayMessages(room: Room): ChatMessage[] {
  const since = Date.now() - VISIBILITY_WINDOW
  return room.messages.filter((m) => m.ts >= since)
}

function pickColor(userId: string): string {
  let hash = 0
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

function sanitizeText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return ''
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  return [...text].slice(0, maxLength).join('')
}

// ── 狀態 ──────────────────────────────────────────────────────────

const connections = new Set<UserConn>()
const rooms = new Map<string, Room>()

// ── Supabase 持久化（未設定環境變數時退回 JSON 檔） ──────────────

const SUPABASE_CONFIG = loadSupabaseConfig()
const db = SUPABASE_CONFIG ? createSupabaseStore(SUPABASE_CONFIG) : null
// 已寫入 Supabase 的房間集合：避免每次插入訊息都重複寫房間列
const persistedRoomIds = new Set<string>()
if (db) console.log('[chat] 對話歷史將存入 Supabase')
else console.log('[chat] Supabase 未設定（SUPABASE_* 環境變數），歷史存 JSON 檔')

/** 房間 → Supabase 列（資料有變動時呼叫；訊息插入前會先確保房間列存在） */
async function persistRoom(room: Room): Promise<void> {
  if (!db) return
  const row: ChatRoomRow = {
    id: room.id,
    name: room.name,
    ownerId: room.ownerId,
    ownerName: room.ownerName,
    expiresAt: room.expiresAt,
    botEnabled: room.botEnabled,
  }
  await db.upsertRoom(row)
  persistedRoomIds.add(room.id)
}

/** 單則訊息寫入 Supabase（fire-and-forget；房間列不存在時先補寫） */
function persistMessage(message: ChatMessage): void {
  if (!db) return
  const room = rooms.get(message.roomId)
  const ensureRoom = room && !persistedRoomIds.has(message.roomId) ? persistRoom(room) : Promise.resolve()
  void ensureRoom.then(() => db.insertMessage(message)).catch((error) => {
    console.error('[chat] 訊息存入 Supabase 失敗', error instanceof Error ? error.message : error)
  })
}

/** 房間資料有變動（例如機器人開關）時更新 Supabase */
async function persistRoomState(room: Room): Promise<void> {
  if (!db) return
  const row: ChatRoomRow = {
    id: room.id,
    name: room.name,
    ownerId: room.ownerId,
    ownerName: room.ownerName,
    expiresAt: room.expiresAt,
    botEnabled: room.botEnabled,
  }
  await db.upsertRoom(row)
  persistedRoomIds.add(room.id)
}

/** 房間消失時從 Supabase 移除（對話一併 cascade 刪除） */
function persistRoomDelete(roomId: string): void {
  if (!db) return
  void db.deleteRoom(roomId).then(() => persistedRoomIds.delete(roomId))
}

/** FAQ 寫入／刪除（/教、/忘） */
async function persistFaq(entry: FaqEntry): Promise<void> {
  if (!db) return
  await db.upsertFaq(entry)
}

async function persistFaqDelete(keyword: string): Promise<void> {
  if (!db) return
  await db.deleteFaq(keyword)
}

/** 自訂 FAQ（/教 指令學習的內容） */
let faqs: FaqEntry[] = []

let saveTimer: NodeJS.Timeout | null = null

// ── JSON 檔持久化（Supabase 未設定時的退回方案） ──────────────────

function loadStoreFromFile(): void {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const store = JSON.parse(raw) as Partial<PersistedStore>
    for (const room of Array.isArray(store.rooms) ? store.rooms : []) {
      rooms.set(room.id, {
        id: room.id,
        name: room.name,
        ownerId: room.ownerId,
        ownerName: room.ownerName ?? null,
        // 舊資料沒有時間戳：自建房間重新起算存活時間
        expiresAt: room.expiresAt ?? (room.ownerId ? Date.now() + ROOM_LIFETIME : null),
        messages: Array.isArray(room.messages) ? room.messages.slice(-MAX_MESSAGES_PER_ROOM) : [],
        members: new Map(),
        botEnabled: room.botEnabled === true,
      })
    }
    if (Array.isArray(store.faqs)) faqs = store.faqs.slice(0, 200)
    console.log(`[chat] 已載入 ${rooms.size} 間房間、${faqs.length} 條自訂回覆`)
  } catch {
    // 沒有舊資料或格式不符，從乾淨狀態開始
  }
}

function scheduleSave(): void {
  if (db) return // Supabase 模式下每筆資料即時寫入，不需要整份快照
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const store: PersistedStore = {
      rooms: [...rooms.values()].map((room) => ({
        id: room.id,
        name: room.name,
        ownerId: room.ownerId,
        ownerName: room.ownerName,
        expiresAt: room.expiresAt,
        messages: room.messages.slice(-MAX_MESSAGES_PER_ROOM),
        botEnabled: room.botEnabled,
      })),
      faqs,
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(DATA_FILE, JSON.stringify(store), 'utf8')
    } catch (error) {
      console.error('[chat] 儲存資料失敗', error)
    }
  }, 500)
}

// ── 房間操作 ──────────────────────────────────────────────────────

function ensureLobby(): Room {
  const existing = rooms.get(LOBBY_ID)
  if (existing) return existing
  const lobby: Room = {
    id: LOBBY_ID,
    name: '大廳',
    ownerId: null,
    ownerName: null,
    expiresAt: null,
    messages: [],
    members: new Map(),
    botEnabled: true,
  }
  rooms.set(lobby.id, lobby)
  return lobby
}

/** 解散聊天室：通知成員並從清單移除（大廳永不解散） */
function closeRoom(room: Room, reason: string): void {
  if (!rooms.has(room.id)) return
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    roomId: room.id,
    kind: 'system',
    senderId: '',
    senderName: '',
    color: '',
    text: `⏹ ${room.name}：${reason}`,
    ts: Date.now(),
  }
  broadcast(room.members.keys(), { type: 'chat', message })
  for (const member of [...room.members.values()]) {
    send(member, { type: 'room:closed', roomId: room.id, reason })
  }
  room.members.clear()
  rooms.delete(room.id)
  persistRoomDelete(room.id)
  broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
  scheduleSave()
}

/** 定時清掃：逾時或 0 人的自建聊天室自動消失；訊息超過保留期（14 天）的剪掉 */
function sweepRooms(): void {
  const now = Date.now()
  const retentionCutoff = now - RETENTION
  for (const room of [...rooms.values()]) {
    // 保留期外的舊訊息從記憶體剪掉（Supabase 有定時清掃）
    const freshness = room.messages.filter((m) => m.ts >= retentionCutoff)
    if (freshness.length !== room.messages.length) room.messages = freshness
    if (room.id === LOBBY_ID) continue
    if (room.members.size === 0) {
      rooms.delete(room.id)
      persistRoomDelete(room.id)
      scheduleSave()
      broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
    } else if (room.expiresAt !== null && now > room.expiresAt) {
      closeRoom(room, `聊天室時間到（存活 ${Math.round(ROOM_LIFETIME / 60000)} 分鐘），已自動解散`)
    }
  }
}

/** 定時清除 Supabase 裡超過保留期（14 天）的訊息 */
function scheduleSupabasePurge(): void {
  if (!db) return
  const flush = () => {
    void db.purgeOldMessages()
  }
  flush()
  setInterval(flush, 6 * 60 * 60 * 1000).unref()
}

// ── LLM 設定 ──────────────────────────────────────────────────────

const LLM = loadLlmConfig()
if (LLM) console.log(`[chat] LLM 已啟用: ${LLM.model} @ ${LLM.baseUrl}`)
else console.log('[chat] LLM 未設定（CHAT_LLM_* 環境變數），使用內建回覆')

function broadcast(userIds: Iterable<string>, msg: ServerMsg, exceptUserId?: string): void {
  const payload = JSON.stringify(msg)
  for (const userId of userIds) {
    if (userId === exceptUserId) continue
    const conn = [...connections.values()].find((c) => c.userId === userId)
    if (conn && conn.socket.readyState === conn.socket.OPEN) conn.socket.send(payload)
  }
}

function broadcastToAll(msg: ServerMsg, except?: UserConn): void {
  const payload = JSON.stringify(msg)
  for (const conn of connections) {
    if (conn === except || conn.socket.readyState !== conn.socket.OPEN) continue
    conn.socket.send(payload)
  }
}

function roomSummaries(): RoomSummary[] {
  const list = [...rooms.values()].map((room): RoomSummary => {
    const last = room.messages[room.messages.length - 1]
    let members: MemberInfo[] = [...room.members.values()].map((member) => ({
      userId: member.userId,
      nickname: member.nickname,
      color: member.color,
    }))
    members = members.filter((member, index, arr) => arr.findIndex((m) => m.userId === member.userId) === index)
    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      members,
      lastMessage: last
        ? { text: last.text, ts: last.ts, senderName: last.senderName }
        : null,
      botEnabled: room.botEnabled,
      expiresAt: room.expiresAt,
    }
  })
  // 大廳固定在最前面，其餘依最後活動時間排序
  list.sort((a, b) => {
    if (a.id === LOBBY_ID) return -1
    if (b.id === LOBBY_ID) return 1
    return (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0)
  })
  return list
}

function postSystemMessage(room: Room, text: string): ChatMessage {
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    roomId: room.id,
    kind: 'system',
    senderId: '',
    senderName: '',
    color: '',
    text,
    ts: Date.now(),
  }
  room.messages.push(message)
  if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
    room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM)
  }
  persistMessage(message)
  broadcast(room.members.keys(), { type: 'chat', message })
  broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
  scheduleSave()
  return message
}

// ── 機器人 ────────────────────────────────────────────────────────

interface BotPersona {
  id: string
  name: string
  color: string
}

const HELPER: BotPersona = { id: BOT_USER_ID, name: BOT_NICKNAME, color: BOT_COLOR }
const TUTOR: BotPersona = { id: BOT_EN_USER_ID, name: BOT_EN_NICKNAME, color: BOT_EN_COLOR }

function botMessage(roomId: string, text: string, persona: BotPersona = HELPER, ts = Date.now()): ChatMessage {
  // bot／LLM 產出的文字同樣過敏感詞，避免回嘴內容破功
  const cleaned = maskSensitiveWords(text, BLOCKED_WORDS)
  return {
    id: crypto.randomUUID(),
    roomId,
    kind: 'chat',
    senderId: persona.id,
    senderName: persona.name,
    color: persona.color,
    text: cleaned.text,
    ts,
  }
}

/** 私訊版 bot 回覆：只傳給指定的人，不進歷史 */
function botReplyPrivate(conn: UserConn, roomId: string, text: string, persona: BotPersona = HELPER): void {
  send(conn, { type: 'chat', message: botMessage(roomId, text, persona, Date.now() + 1) })
}

function botTyping(room: Room, persona: BotPersona, value: boolean): void {
  broadcast(room.members.keys(), {
    type: 'typing',
    roomId: room.id,
    userId: persona.id,
    nickname: persona.name,
    typing: value,
  })
}

/** bot 訊息存進歷史並廣播全房間，接著產生 AI 語音 */
function botDeliver(room: Room, text: string, persona: BotPersona = HELPER): void {
  if (!rooms.has(room.id)) return
  const message = botMessage(room.id, text, persona, Date.now())
  room.messages.push(message)
  if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
    room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM)
  }
  persistMessage(message)
  broadcast(room.members.keys(), { type: 'chat', message })
  broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
  scheduleSave()

  // AI 語音：依內容語言選聲音（英文 → 英文聲，中文 → 台灣聲）
  const voice: 'en' | 'zh' = isMostlyChinese(message.text) ? 'zh' : 'en'
  void deliverTts(room, message, voice)
}

/** 產生語音並廣播給房間成員（失敗靜默，前端有瀏覽器 TTS 備援） */
async function deliverTts(room: Room, message: ChatMessage, voice: 'en' | 'zh'): Promise<void> {
  const audio = await synthesize(message.text, voice)
  if (!audio || !rooms.has(room.id)) return
  broadcast(room.members.keys(), {
    type: 'audio',
    roomId: room.id,
    messageId: message.id,
    data: audio.toString('base64'),
    voice,
  })
}

/** 小幫手智慧回覆：有 LLM 就走 LLM，失敗退回罐頭回覆 */
async function helperSmartReply(room: Room, question: boolean): Promise<void> {
  const context: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of room.messages.slice(-14)) {
    if (m.kind !== 'chat') continue
    if (m.senderId === BOT_USER_ID) {
      context.push({ role: 'assistant', content: m.text })
    } else {
      context.push({ role: 'user', content: `${m.senderName}：${m.text}` })
    }
  }
  botTyping(room, HELPER, true)
  const answer = LLM ? await llmChat(LLM, [{ role: 'system', content: HELPER_SYSTEM_PROMPT }, ...context]) : null
  botTyping(room, HELPER, false)
  if (answer) {
    botDeliver(room, answer)
    return
  }
  // 沒有 LLM 或呼叫失敗：沿用罐頭回覆
  botDeliver(room, question ? fallbackReply() : greetingReply())
}

/** 公開版 bot 回覆：先顯示「正在輸入」，延遲後播給全房間並存入歷史 */
function botReplyPublic(room: Room, text: string, persona: BotPersona = HELPER): void {
  botTyping(room, persona, true)
  const delay = Math.min(400 + text.length * 25, 1600)
  setTimeout(() => {
    botTyping(room, persona, false)
    botDeliver(room, text, persona)
  }, delay)
}

/** 英文助教：翻譯（亞洲時間可能需數秒）並唸出 */
function tutorTranslateReply(room: Room, query: string): void {
  if (!rooms.has(room.id)) return
  botTyping(room, TUTOR, true)
  translateText(query)
    .then((translated) => botDeliver(room, translated, TUTOR))
    .catch(() => botDeliver(room, '⚠️ 翻譯服務暫時無法連線，請稍後再試。', TUTOR))
    .finally(() => botTyping(room, TUTOR, false))
}

/** 處理「/」開頭的指令（不會廣播給其他人） */
function handleCommand(conn: UserConn, room: Room, cmd: Command): void {
  // 需要操作房間資料的指令
  if (cmd.name === '成員' || cmd.name === 'members') {
    const names = [...room.members.values()].map((m) => m.nickname).concat(room.botEnabled ? [BOT_NICKNAME] : [])
    const unique = [...new Set(names)]
    botReplyPublic(room, `👥「${room.name}」的成員（${unique.length} 人）：${unique.join('、')}`)
    return
  }

  if (cmd.name === '教') {
    const sep = cmd.args.indexOf('=')
    const keyword = (sep >= 0 ? cmd.args.slice(0, sep) : '').trim()
    const answer = (sep >= 0 ? cmd.args.slice(sep + 1) : '').trim()
    if (!keyword || !answer) {
      botReplyPrivate(conn, room.id, '格式：/教 關鍵字=回答（例如：/教 訂餐=明天中午前找班長登記）')
      return
    }
    if ([...keyword].length > 20 || [...answer].length > 500) {
      botReplyPrivate(conn, room.id, '關鍵字最長 20 字、回答最長 500 字喔！')
      return
    }
    faqs = faqs.filter((faq) => faq.keyword !== keyword)
    faqs.push({ keyword, answer })
    scheduleSave()
    void persistFaq({ keyword, answer })
    botReplyPrivate(conn, room.id, `✅ 學會了！之後訊息只要包含「${keyword}」，我就會自動回答。`)
    return
  }

  if (cmd.name === '忘') {
    const keyword = cmd.args
    const before = faqs.length
    faqs = faqs.filter((faq) => faq.keyword !== keyword)
    scheduleSave()
    void persistFaqDelete(keyword)
    botReplyPrivate(conn, room.id, faqs.length < before ? `✅ 已忘記「${keyword}」` : `我本來就沒學過「${keyword}」喔`)
    return
  }

  // 英文助教的翻譯指令
  if (cmd.name === '翻譯' || cmd.name === '翻' || cmd.name === 'translate') {
    if (!cmd.args) {
      botReplyPrivate(conn, room.id, tutorIntro(), TUTOR)
      return
    }
    tutorTranslateReply(room, cmd.args)
    return
  }

  const reply = commandReply(cmd, { userId: conn.userId, nickname: conn.nickname, faqs })
  if (!reply) return
  if (reply.public) {
    botReplyPublic(room, reply.text)
  } else {
    botReplyPrivate(conn, room.id, reply.text)
  }
}

function joinRoom(conn: UserConn, room: Room, announce = true): void {
  if (room.members.has(conn.userId)) return
  room.members.set(conn.userId, conn)
  if (announce) postSystemMessage(room, `${conn.nickname} 加入了「${room.name}」`)
  broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
}

function leaveRoom(conn: UserConn, room: Room, announce = true): void {
  if (!room.members.has(conn.userId)) return
  room.members.delete(conn.userId)
  if (announce) postSystemMessage(room, `${conn.nickname} 離開了「${room.name}」`)
  // 自建聊天室 0 人時立即消失（大廳除外）
  if (room.id !== LOBBY_ID && room.members.size === 0) {
    closeRoom(room, '沒有人留在聊天室，已自動解散')
    return
  }
  broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
}

// ── 訊息處理 ──────────────────────────────────────────────────────

function handleClientMsg(conn: UserConn, raw: string): void {
  let msg: ClientMsg
  try {
    msg = JSON.parse(raw) as ClientMsg
  } catch {
    send(conn, { type: 'error', message: '無法解析訊息' })
    return
  }

  if (msg.type === 'hello') {
    const nickname = sanitizeText(msg.nickname, MAX_NICKNAME_LENGTH)
    if (!nickname) {
      send(conn, { type: 'error', message: '請先填寫暱稱' })
      return
    }
    const isNew = conn.nickname === ''
    conn.nickname = nickname
    const color = typeof msg.color === 'string' && AVATAR_COLORS.includes(msg.color as never)
      ? msg.color
      : conn.color
    conn.color = color
    // hello 之後一律送出 welcome；新連線再自動加入大廳
    send(conn, { type: 'welcome', user: { userId: conn.userId, nickname, color } })
    if (isNew) joinRoom(conn, ensureLobby())
    broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
    return
  }

  if (msg.type === 'room:create') {
    const name = maskSensitiveWords(sanitizeText(msg.name, MAX_ROOM_NAME_LENGTH), BLOCKED_WORDS).text
    if (!name) {
      send(conn, { type: 'error', message: '請輸入房間名稱' })
      return
    }
    // 限額：每位使用者同時只能擁有 1 間自建聊天室（重連後 userId 會換，改用暱稱判定）
    const mine = [...rooms.values()].filter(
      (room) => room.ownerId === conn.userId || (room.ownerName !== null && room.ownerName === conn.nickname),
    )
    if (mine.length >= MAX_ROOMS_PER_USER) {
      send(conn, {
        type: 'error',
        message: `每位使用者只能建立 ${MAX_ROOMS_PER_USER} 間聊天室（你已建立「${mine[0].name}」，閒置 1 小時或沒有人時會自動解散）`,
      })
      return
    }
    const room: Room = {
      id: crypto.randomUUID(),
      name,
      ownerId: conn.userId,
      ownerName: conn.nickname,
      expiresAt: Date.now() + ROOM_LIFETIME,
      messages: [],
      members: new Map(),
      botEnabled: false,
    }
    rooms.set(room.id, room)
    void persistRoom(room)
    joinRoom(conn, room, false)
    send(conn, { type: 'joined', roomId: room.id, messages: displayMessages(room) })
    postSystemMessage(room, `${conn.nickname} 建立了「${room.name}」（存活 ${Math.round(ROOM_LIFETIME / 60000)} 分鐘，沒有人時會立即解散）`)
    return
  }

  if (msg.type === 'room:join') {
    const room = rooms.get(msg.roomId)
    if (!room) {
      send(conn, { type: 'error', message: '找不到該房間' })
      return
    }
    joinRoom(conn, room)
    send(conn, { type: 'joined', roomId: room.id, messages: displayMessages(room) })
    return
  }

  if (msg.type === 'room:leave') {
    const room = rooms.get(msg.roomId)
    if (room) leaveRoom(conn, room)
    return
  }

  if (msg.type === 'chat') {
    const room = rooms.get(msg.roomId)
    if (!room || !room.members.has(conn.userId)) {
      send(conn, { type: 'error', message: '你不在這個房間' })
      return
    }
    const cleaned = maskSensitiveWords(sanitizeText(msg.text, MAX_TEXT_LENGTH), BLOCKED_WORDS)
    const text = cleaned.text
    if (!text) return
    if (cleaned.masked > 0) {
      botReplyPrivate(conn, room.id, '⚠️ 你的訊息包含的部分文字不適合在聊天室出現，已自動遮蔽。請注意用語喔！')
    }

    // 斜線指令：只讓 bot 私下回覆，不對其他人廣播
    const command = parseCommand(text)
    if (command) {
      handleCommand(conn, room, command)
      return
    }

    // 一般訊息正常廣播
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      roomId: room.id,
      kind: 'chat',
      senderId: conn.userId,
      senderName: conn.nickname,
      color: conn.color,
      text,
      ts: Date.now(),
    }
    room.messages.push(message)
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM)
    }
    persistMessage(message)
    broadcast(room.members.keys(), { type: 'chat', message })
    // 同步側欄的最新訊息預覽
    broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
    scheduleSave()

    // 英文助教：被點名時負責翻譯
    if (isTutorMention(text)) {
      const query = extractTutorQuery(text)
      if (!query) {
        botReplyPublic(room, tutorIntro(), TUTOR)
      } else {
        tutorTranslateReply(room, query)
      }
      return
    }

    // 英文教室模式：自己的訊息自動翻譯處理
    if (conn.tutorMode) {
      tutorTranslateReply(room, text)
      return
    }

    // 機器人：被點名必回；開啟時，訊息命中自訂 FAQ 也會自動回答
    const mention = isBotMention(text)
    const faqHit = matchFaq(text, faqs)
    if (room.botEnabled || mention) {
      if (faqHit) {
        botReplyPublic(room, faqHit.answer)
      } else if (mention) {
        // 點名小幫手：智慧答詢（LLM，未設定則罐頭）
        void helperSmartReply(room, isQuestion(text))
      }
    }
    return
  }

  if (msg.type === 'bot') {
    const room = rooms.get(msg.roomId)
    if (!room || !room.members.has(conn.userId)) return
    room.botEnabled = msg.enabled === true
    void persistRoomState(room)
    broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
    botReplyPrivate(
      conn,
      room.id,
      room.botEnabled
        ? `🤖 已在「${room.name}」開啟自動答詢！訊息命中關鍵字我就會回答，輸入「/說明」看更多指令。`
        : `🤐 已關閉「${room.name}」的自動答詢（訊息中點名「小幫手」仍然有效）`,
    )
    return
  }

  if (msg.type === 'tutor') {
    conn.tutorMode = msg.enabled === true
    const lobbyRoom = rooms.get(LOBBY_ID)
    if (lobbyRoom && lobbyRoom.members.has(conn.userId)) {
      botReplyPrivate(
        conn,
        lobbyRoom.id,
        conn.tutorMode
          ? '👨‍🏫 已進入英文教室！你之後傳的訊息會自動翻譯（中→英）並朗讀，其他同學也看得到。要離開請再點一次「英文助教」按鈕。'
          : '👋 已離開英文教室，恢復一般聊天模式。',
        TUTOR,
      )
    }
    return
  }

  if (msg.type === 'typing') {
    const room = rooms.get(msg.roomId)
    if (!room || !room.members.has(conn.userId)) return
    broadcast(
      room.members.keys(),
      {
        type: 'typing',
        roomId: room.id,
        userId: conn.userId,
        nickname: conn.nickname,
        typing: msg.typing === true,
      },
      conn.userId,
    )
    return
  }

  send(conn, { type: 'error', message: '不支援的訊息類型' })
}

function send(conn: UserConn, msg: ServerMsg): void {
  if (conn.socket.readyState === conn.socket.OPEN) {
    conn.socket.send(JSON.stringify(msg))
  }
}

// ── 伺服器 ────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/**
 * 發送 dist/ 靜態檔：正式部署時單一服務同時提供網頁與 WebSocket。
 * 回 false 表示沒有處理（例如 dist 未建置），呼叫端改回 JSON 預設回應。
 */
function serveStatic(request: http.IncomingMessage, res: http.ServerResponse): boolean {
  const urlPath = (request.url ?? '/').split('?')[0]
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, users: connections.size }))
    return true
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    decoded = urlPath
  }
  const safePath = path.posix.normalize(decoded)
  if (safePath.includes('..')) {
    res.writeHead(403)
    res.end()
    return true
  }
  let filePath = path.join(DIST_DIR, safePath)
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html') // SPA fallback
  }
  if (!fs.existsSync(filePath)) return false // dist 未建置（本地開發模式）
  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' })
  if (request.method === 'HEAD') {
    res.end()
  } else {
    res.end(fs.readFileSync(filePath))
  }
  return true
}

const httpServer = http.createServer((req, res) => {
  if (serveStatic(req, res)) return
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, rooms: rooms.size }))
})

const wss = new WebSocketServer({ server: httpServer, maxPayload: 512 * 1024 })

wss.on('connection', (socket: WebSocket) => {
  const conn: UserConn = {
    socket,
    userId: crypto.randomUUID(),
    nickname: '',
    color: pickColor(crypto.randomUUID()),
    alive: true,
    tutorMode: false,
  }
  connections.add(conn)

  socket.on('pong', () => {
    conn.alive = true
  })

  socket.on('message', (data) => {
    try {
      handleClientMsg(conn, data.toString())
    } catch (error) {
      console.error('[chat] 處理訊息時發生錯誤', error)
    }
  })

  socket.on('close', () => {
    connections.delete(conn)
    for (const room of rooms.values()) {
      if (room.members.has(conn.userId)) leaveRoom(conn, room, true)
    }
  })

  socket.on('error', (error) => {
    console.error('[chat] 連線錯誤', error)
  })
})

// 心跳：清理沒有回應的連線
const heartbeat = setInterval(() => {
  for (const conn of connections) {
    if (!conn.alive) {
      conn.socket.terminate()
      continue
    }
    conn.alive = false
    conn.socket.ping()
  }
}, HEARTBEAT_MS)

// 定時清掃自建的空房間／逾時房間
const roomSweeper = setInterval(sweepRooms, 15_000)
wss.on('close', () => {
  clearInterval(heartbeat)
  clearInterval(roomSweeper)
})

// ── 啟動 ──────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  wss.close()
  httpServer.close(() => process.exit(0))
})

/** 啟動：先從 Supabase（或 JSON 檔）載入狀態，就緒後才開始接受連線 */
async function setupAndStart(): Promise<void> {
  if (db) {
    try {
      const state = await db.loadState()
      if (state) {
        for (const row of state.rooms) {
          rooms.set(row.id, {
            id: row.id,
            name: row.name,
            ownerId: row.ownerId,
            ownerName: row.ownerName,
            // 沒有時間戳的自建房間：重新起算存活時間
            expiresAt: row.expiresAt ?? (row.ownerId ? Date.now() + ROOM_LIFETIME : null),
            messages: row.messages,
            members: new Map(),
            botEnabled: row.botEnabled,
          })
          persistedRoomIds.add(row.id)
        }
        faqs = state.faqs.slice(0, 200)
        console.log(`[chat] 已從 Supabase 載入 ${state.rooms.length} 間房間、${faqs.length} 條自訂回覆`)
      } else {
        console.log('[chat] Supabase 讀取失敗，從空狀態啟動')
      }
    } catch (error) {
      console.error('[chat] Supabase 載入發生錯誤', error)
    }
    ensureLobby()
    if (rooms.has(LOBBY_ID)) await persistRoom(rooms.get(LOBBY_ID)!)
  } else {
    loadStoreFromFile()
    ensureLobby()
  }

  sweepRooms() // 重新啟動時立刻清掉上次殘留的空房間／逾時房間
  scheduleSupabasePurge() // Supabase：啟動時與每 6 小時清掉 14 天前的舊訊息
  httpServer.listen(PORT, () => {
    console.log(`[chat] 聊天伺服器啟動於 ws://localhost:${PORT}/ws`)
  })
}

void setupAndStart()
