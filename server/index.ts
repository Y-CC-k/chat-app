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
  ENGLISH_ROOM_ID,
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
  fallbackReply,
  greetingReply,
  isBotMention,
  isQuestion,
  isTutorMention,
  isComplaint,
  complaintReply,
  matchFaq,
  parseCommand,
  translateText,
  tutorIntro,
  isMostlyChinese,
  isMostlyEnglish,
  type Command,
} from './bot'
import { HELPER_SYSTEM_PROMPT, llmChatChain, loadLlmConfig } from './llm'
import { calendarPlainAnswer, isCalendarQuestion, schoolCalendarContext } from './calendar'
import { isSchoolInfoQuestion, schoolBoardPlainAnswer, schoolWebContext } from './schoolinfo'
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

/** 另存一條機器人問答記錄到 Supabase 的 bot_qa_logs（fire-and-forget；房間解散不受影響） */
function logBotQa(question: string, answer: string, source: string, asker: string, roomName: string): void {
  if (!db) return
  void db.insertBotQa({ question, answer, source, nickname: asker, roomName })
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

/** 內建英文教室：像大廳一樣永不解散，朗讀（TTS）與自動翻譯唯一的房間 */
function ensureEnglishRoom(): Room {
  const existing = rooms.get(ENGLISH_ROOM_ID)
  if (existing) return existing
  const room: Room = {
    id: ENGLISH_ROOM_ID,
    name: '英文教室',
    ownerId: null,
    ownerName: null,
    expiresAt: null,
    messages: [],
    members: new Map(),
    botEnabled: false,
  }
  rooms.set(room.id, room)
  return room
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
    if (room.id === LOBBY_ID || room.id === ENGLISH_ROOM_ID) continue
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

/** 定時清除 Supabase 裡超過保留期（14 天）的訊息與機器人問答記錄 */
function scheduleSupabasePurge(): void {
  if (!db) return
  const flush = () => {
    void db.purgeOldMessages()
    void db.purgeOldBotQa()
  }
  flush()
  setInterval(flush, 6 * 60 * 60 * 1000).unref()
}

// ── LLM 設定 ──────────────────────────────────────────────────────

const LLM = loadLlmConfig()
if (LLM.length > 0) console.log(`[chat] LLM 已啟用（${LLM.length} 條路由）: ` + LLM.map((c) => c.model).join(' → '))
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
  // 大廳固定最前面、英文教室接力，其餘依最後活動時間排序
  list.sort((a, b) => {
    if (a.id === LOBBY_ID) return -1
    if (b.id === LOBBY_ID) return 1
    if (a.id === ENGLISH_ROOM_ID) return -1
    if (b.id === ENGLISH_ROOM_ID) return 1
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

  // AI 語音：朗讀只在「英文教室」啟用（依內容語言選聲音；其他房間一律靜音）
  if (room.id === ENGLISH_ROOM_ID) {
    const voice: 'en' | 'zh' = isMostlyChinese(message.text) ? 'zh' : 'en'
    void deliverTts(room, message, voice)
  }
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

/** 小幫手智慧回覆：有 LLM 就走 LLM，失敗退回罐頭回覆；問答同時另存記錄 */
async function helperSmartReply(room: Room, questionText: string, question: boolean, asker: string): Promise<void> {
  const context: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of room.messages.slice(-14)) {
    if (m.kind !== 'chat') continue
    if (m.senderId === BOT_USER_ID) {
      context.push({ role: 'assistant', content: m.text })
    } else {
      context.push({ role: 'user', content: `${m.senderName}：${m.text}` })
    }
  }
  // 學校事情查證：即時抓學校網站（佈告欄／行事曆）→ 教育局網站，把真資料交給 LLM
  let systemPrompt = HELPER_SYSTEM_PROMPT
  const webParts: string[] = []
  const cal = isCalendarQuestion(questionText) ? await schoolCalendarContext() : null
  if (cal) webParts.push(cal)
  const info = await schoolWebContext(questionText)
  if (info) webParts.push(info)
  if (webParts.length > 0) {
    systemPrompt += `\n\n以下是剛剛即時從「學校網站／教育局網站」查到的參考資料，回答時以資料為準，資料裡沒有的細節不可編造：\n\n${webParts.join('\n\n')}`
  }
  botTyping(room, HELPER, true)
  const answer = LLM.length > 0 ? await llmChatChain(LLM, [{ role: 'system', content: systemPrompt }, ...context]) : null
  botTyping(room, HELPER, false)
  if (answer) {
    botDeliver(room, answer)
    logBotQa(questionText, answer, 'llm', asker, room.name)
    return
  }
  // 沒有 LLM 或呼叫失敗：能查到的真資料直接念出來（行事曆 → 學校公告 → 罐頭）
  if (isCalendarQuestion(questionText)) {
    const plain = await calendarPlainAnswer()
    if (plain) {
      botDeliver(room, plain)
      logBotQa(questionText, plain, 'fallback', asker, room.name)
      return
    }
  }
  if (isSchoolInfoQuestion(questionText)) {
    const board = await schoolBoardPlainAnswer()
    if (board) {
      botDeliver(room, board)
      logBotQa(questionText, board, 'fallback', asker, room.name)
      return
    }
  }
  const fallback = question ? fallbackReply() : greetingReply()
  botDeliver(room, fallback)
  logBotQa(questionText, fallback, 'fallback', asker, room.name)
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

/** 英文助教：翻譯（亞洲時間可能需數秒）並唸出；問答同時另存記錄 */
function tutorTranslateReply(room: Room, query: string, asker: string): void {
  if (!rooms.has(room.id)) return
  botTyping(room, TUTOR, true)
  translateText(query)
    .then((translated) => {
      botDeliver(room, translated, TUTOR)
      if (isMostlyChinese(query) || isMostlyEnglish(query)) logBotQa(query, translated, 'tutor', asker, room.name)
    })
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
    // 翻譯與朗讀是英文教室的專屬功能：其他房間只引導，不翻譯
    if (room.id !== ENGLISH_ROOM_ID) {
      botReplyPrivate(conn, room.id, '📢 翻譯與朗讀只有在「英文教室」才有喔！請從房間清單加入「英文教室」。', TUTOR)
      return
    }
    if (!cmd.args) {
      botReplyPrivate(conn, room.id, tutorIntro(), TUTOR)
      return
    }
    tutorTranslateReply(room, cmd.args, conn.nickname)
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
  // 同暱稱的死連線（關掉的舊分頁／剛斷線的舊 socket）先清掉：人數不膨脹、也不顯示一堆重複「加入了」
  for (const [uid, m] of [...room.members]) {
    if (m.nickname === conn.nickname && m.socket.readyState >= 2) room.members.delete(uid)
  }
  // 還有活的同暱稱成員（同一人多開）就不重播加入語
  const quiet = !announce || [...room.members.values()].some((m) => m.nickname === conn.nickname)
  room.members.set(conn.userId, conn)
  if (!quiet) postSystemMessage(room, `${conn.nickname} 加入了「${room.name}」`)
  broadcastToAll({ type: 'rooms', rooms: roomSummaries() })
}

function leaveRoom(conn: UserConn, room: Room, announce = true): void {
  if (!room.members.has(conn.userId)) return
  room.members.delete(conn.userId)
  if (announce) postSystemMessage(room, `${conn.nickname} 離開了「${room.name}」`)
  // 自建聊天室 0 人時立即消失（大廳與英文教室除外）
  if (room.id !== LOBBY_ID && room.id !== ENGLISH_ROOM_ID && room.members.size === 0) {
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
    // hello 之後一律送出 welcome；新連線再自動加入大廳（widget 訪客帶 skipLobby，不進大廳）
    send(conn, { type: 'welcome', user: { userId: conn.userId, nickname, color } })
    if (isNew && msg.skipLobby !== true) joinRoom(conn, ensureLobby())
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
    // 若舊房還在：一律重新進入那間房（續聊歷史紀錄），避免「重新整理後開不了房卡死」
    const mine = [...rooms.values()].filter(
      (room) => room.ownerId === conn.userId || (room.ownerName !== null && room.ownerName === conn.nickname),
    )
    if (mine.length >= MAX_ROOMS_PER_USER) {
      const existing = mine.find((room) => room.ownerId === conn.userId) ?? mine[0]
      joinRoom(conn, existing)
      send(conn, { type: 'joined', roomId: existing.id, messages: displayMessages(existing) })
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
    const cleaned = maskSensitiveWords(sanitizeText(msg.text ?? '', MAX_TEXT_LENGTH), BLOCKED_WORDS)
    let text = cleaned.text
    // 「@ 問題」：不用開關，開頭為 @ 即視為向機器人提問（@ 後可接空格）
    const askedByAt = text.startsWith('@') && (text.length === 1 || text[1] === ' ' || text[1] === '\t')
    if (askedByAt) text = text.slice(1).trim()
    // 貼圖／圖片訊息：text 可為空，但 image/sticker 其一必須存在
    let sticker = typeof msg.sticker === 'string' ? msg.sticker.trim().slice(0, 8) : ''
    if (sticker && ![...sticker].every((ch) => /[\p{Emoji}\p{Emoji_Component}]/u.test(ch))) sticker = ''
    let image = typeof msg.image === 'string' ? msg.image.trim() : ''
    // 只接受自己上傳到 Supabase storage 的圖片連結，避免任意外部圖片
    if (image) {
      const prefix = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '') + '/storage/v1/object/public/chat-images/'
      if (!image.startsWith(prefix)) image = ''
    }
    if (!text && !image && !sticker) return
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
      image: image || undefined,
      sticker: sticker || undefined,
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

    // 英文教室：房內唯一有朗讀功能——自己的訊息朗讀＋英文助教自動翻譯
    if (room.id === ENGLISH_ROOM_ID) {
      if (text) {
        const voice: 'en' | 'zh' = isMostlyChinese(text) ? 'zh' : 'en'
        void deliverTts(room, message, voice)
        tutorTranslateReply(room, text, conn.nickname)
      }
      return
    }

    // 其他房間沒有英文教室功能（不翻譯、不朗讀）：改成引導到英文教室
    if (isTutorMention(text)) {
      botReplyPrivate(conn, room.id, '📢 朗讀與翻譯只有在「英文教室」才有喔！請從房間清單加入「英文教室」，英文助教在那邊等你！', TUTOR)
      return
    }

    // 抱怨／負面申訴語句：不交給 LLM 發揮，統一溫和導引洽學校處理
    if (isComplaint(text)) {
      botReplyPublic(room, complaintReply())
      logBotQa(text, complaintReply(), 'complaint', conn.nickname, room.name)
      return
    }

    // 機器人：被點名必回；開啟時，訊息命中自訂 FAQ 也會自動回答
    // 私人小幫手房：房內只有房主本人（同暱稱；同一人開多個分頁也算）時，每句都視同點名，保證有回應
    const mention = isBotMention(text)
    const faqHit = matchFaq(text, faqs)
    const memberNicknames = new Set([...room.members.values()].map((m) => m.nickname))
    const onlyOwnerInside = memberNicknames.size === 1 && memberNicknames.has(room.ownerName ?? '')
    const privateHelper = room.botEnabled && room.ownerId !== null && onlyOwnerInside
    // 「@ 問題」或私人小幫手房：每句都視為提問
    if (askedByAt || room.botEnabled || mention || privateHelper) {
      if (faqHit) {
        botReplyPublic(room, faqHit.answer)
        logBotQa(text, faqHit.answer, 'faq', conn.nickname, room.name)
      } else if (mention || privateHelper || askedByAt) {
        // 點名小幫手：智慧答詢（LLM，未設定則罐頭）
        void helperSmartReply(room, text, isQuestion(text), conn.nickname)
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
    // 前端「英文教室」按鈕：開 = 加入英文教室房；關 = 離開（房間本身永不解散）
    if (msg.enabled === true) {
      const room = ensureEnglishRoom()
      joinRoom(conn, room)
      send(conn, { type: 'joined', roomId: room.id, messages: displayMessages(room) })
    } else {
      const room = rooms.get(ENGLISH_ROOM_ID)
      if (room) leaveRoom(conn, room)
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
  // widget.js 要永不快取——嵌入別人網頁的單檔外掛一更新，訪客重新整理就會拿到新版
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    ...(ext === '.js' ? { 'Cache-Control': 'no-cache' } : {}),
  })
  if (request.method === 'HEAD') {
    res.end()
  } else {
    res.end(fs.readFileSync(filePath))
  }
  return true
}

/** 上傳圖片到 Supabase storage（chat-images 公開 bucket），回傳公開 URL */
const SUPABASE_URL_ENV = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
const SUPABASE_KEY_ENV = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const CHAT_IMAGES_BUCKET = 'chat-images'

async function ensureChatImagesBucket(): Promise<void> {
  if (!SUPABASE_URL_ENV || !SUPABASE_KEY_ENV) return
  try {
    await fetch(`${SUPABASE_URL_ENV}/storage/v1/bucket`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY_ENV, Authorization: `Bearer ${SUPABASE_KEY_ENV}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: CHAT_IMAGES_BUCKET, name: CHAT_IMAGES_BUCKET, public: true, file_size_limit: 3145728, allowed_mime_types: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'] }),
    })
  } catch (error) {
    console.error('[chat] 建立 chat-images bucket 失敗', error instanceof Error ? error.message : error)
  }
}

async function uploadImageBuffer(buffer: Buffer, contentType: string): Promise<string | null> {
  if (!SUPABASE_URL_ENV || !SUPABASE_KEY_ENV) return null
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : contentType.includes('gif') ? 'gif' : 'jpg'
  const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`
  try {
    const res = await fetch(`${SUPABASE_URL_ENV}/storage/v1/object/${CHAT_IMAGES_BUCKET}/${filename}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY_ENV, Authorization: `Bearer ${SUPABASE_KEY_ENV}`, 'Content-Type': contentType, 'x-upsert': 'false' },
      body: buffer,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error('[chat] 圖片上傳失敗', res.status, detail.slice(0, 200))
      return null
    }
    return `${SUPABASE_URL_ENV}/storage/v1/object/public/${CHAT_IMAGES_BUCKET}/${filename}`
  } catch (error) {
    console.error('[chat] 圖片上傳錯誤', error instanceof Error ? error.message : error)
    return null
  }
}

const httpServer = http.createServer((req, res) => {
  // 上傳圖片（base64 JSON）：POST /upload  { data: base64, mime: 'image/png' }
  if (req.method === 'POST' && (req.url ?? '').split('?')[0] === '/upload') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    const chunks: Buffer[] = []
    let size = 0
    const LIMIT = 4 * 1024 * 1024
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > LIMIT) { req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: string; mime?: string }
        const mime = (body.mime ?? '').toLowerCase()
        const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']
        if (!allowed.includes(mime) || !body.data) {
          res.writeHead(400); res.end(JSON.stringify({ error: '不支援的圖片格式' })); return
        }
        const buffer = Buffer.from(body.data, 'base64')
        if (buffer.length === 0 || buffer.length > 3 * 1024 * 1024) {
          res.writeHead(400); res.end(JSON.stringify({ error: '圖片太大（上限 3MB）' })); return
        }
        const url = await uploadImageBuffer(buffer, mime)
        if (!url) { res.writeHead(500); res.end(JSON.stringify({ error: '上傳失敗' })); return }
        res.writeHead(200); res.end(JSON.stringify({ url }))
      } catch (error) {
        res.writeHead(400); res.end(JSON.stringify({ error: '無法解析上傳內容' }))
      }
    })
    return
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.writeHead(204); res.end(); return
  }
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
    ensureEnglishRoom()
    if (rooms.has(LOBBY_ID)) await persistRoom(rooms.get(LOBBY_ID)!)
    if (rooms.has(ENGLISH_ROOM_ID)) await persistRoom(rooms.get(ENGLISH_ROOM_ID)!)
    await ensureChatImagesBucket()
  } else {
    loadStoreFromFile()
    ensureLobby()
    ensureEnglishRoom()
    await ensureChatImagesBucket()
  }

  sweepRooms() // 重新啟動時立刻清掉上次殘留的空房間／逾時房間
  scheduleSupabasePurge() // Supabase：啟動時與每 6 小時清掉 14 天前的舊訊息
  httpServer.listen(PORT, () => {
    console.log(`[chat] 聊天伺服器啟動於 ws://localhost:${PORT}/ws`)
  })
}

void setupAndStart()
