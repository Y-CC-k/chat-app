import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ENGLISH_ROOM_ID,
  LOBBY_ID,
  MATH_ROOM_ID,
  type ChatMessage,
  type ClientMsg,
  type RoomSummary,
  type ServerMsg,
  type ServerUser,
} from '@shared/protocol'
import { loadAutoSpeak, saveAutoSpeak, shouldAutoSpeak, speak, stopSpeak, toAudioUrl } from '../utils/speech'

export interface TypingUser {
  userId: string
  nickname: string
  until: number
}

export type ChatStatus = 'connecting' | 'login' | 'ready' | 'disconnected'

const TYPING_KEEP_MS = 3000
const TYPING_SEND_THROTTLE_MS = 1800

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

// ── 登入設定檔與所在房間的持久化（重新整理／重開瀏覽器自動回來） ──

const PROFILE_STORAGE_KEY = 'chat-profile'
const ACTIVE_ROOM_STORAGE_KEY = 'chat-active-room'

function loadSavedProfile(): { nickname: string; color: string } | null {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { nickname?: unknown; color?: unknown }
    if (typeof parsed.nickname === 'string' && parsed.nickname.trim() && typeof parsed.color === 'string') {
      return { nickname: parsed.nickname.trim(), color: parsed.color }
    }
    return null
  } catch {
    return null
  }
}

function saveProfile(profile: { nickname: string; color: string } | null): void {
  try {
    if (profile) localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile))
    else localStorage.removeItem(PROFILE_STORAGE_KEY)
  } catch {
    // 忽略（隱私模式等）
  }
}

function loadSavedRoom(): string | null {
  try {
    return localStorage.getItem(ACTIVE_ROOM_STORAGE_KEY)
  } catch {
    return null
  }
}

function saveActiveRoom(roomId: string | null): void {
  try {
    if (roomId) localStorage.setItem(ACTIVE_ROOM_STORAGE_KEY, roomId)
    else localStorage.removeItem(ACTIVE_ROOM_STORAGE_KEY)
  } catch {
    // 忽略（隱私模式等）
  }
}

export function useChat() {
  const [status, setStatus] = useState<ChatStatus>('connecting')
  const [user, setUser] = useState<ServerUser | null>(null)
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [typing, setTyping] = useState<Record<string, TypingUser[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [autoSpeak, setAutoSpeak] = useState(() => loadAutoSpeak())
  const [tutorMode, setTutorMode] = useState(false)
  const [mathMode, setMathMode] = useState(false)
  const [audio, setAudio] = useState<Record<string, string>>({})

  const autoSpeakRef = useRef(autoSpeak)
  const tutorModeRef = useRef(false)
  const mathModeRef = useRef(false)

  const wsRef = useRef<WebSocket | null>(null)
  const activeRoomRef = useRef<string | null>(null)
  const pendingRoomRef = useRef<string | null>(null)
  /** 重新整理後自動回登：從 localStorage 載入上次的暱稱（斷線重連、重新整理都用它） */
  const profileRef = useRef<{ nickname: string; color: string } | null>(loadSavedProfile())
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTypingRef = useRef(0)

  const showStatusError = useCallback((message: string) => {
    setError(message)
    window.setTimeout(() => setError((current) => (current === message ? null : current)), 3000)
  }, [])

  const send = useCallback((msg: ClientMsg) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const sendHello = useCallback(() => {
    const profile = profileRef.current
    if (profile) {
      send({ type: 'hello', nickname: profile.nickname, color: profile.color })
    }
  }, [send])

  // ── 連線生命週期 ──────────────────────────────────────────────

  useEffect(() => {
    let disposed = false

    function connect() {
      if (disposed) return
      setStatus('connecting')

      const ws = new WebSocket(wsUrl())
      wsRef.current = ws

      ws.onopen = () => {
        reconnectAttemptRef.current = 0
        // 已經有暱稱（斷線重連）就自動重新登入；否則停在登入畫面
        if (profileRef.current) {
          sendHello()
        } else {
          setStatus('login')
        }
      }

      ws.onclose = () => {
        wsRef.current = null
        if (disposed) return
        setStatus('disconnected')
        const attempt = Math.min(reconnectAttemptRef.current, 5)
        reconnectAttemptRef.current = attempt + 1
        const delay = Math.min(1500 * 2 ** attempt, 8000)
        reconnectTimerRef.current = setTimeout(connect, delay)
      }

      ws.onmessage = (event) => {
        let msg: ServerMsg
        try {
          msg = JSON.parse(event.data as string) as ServerMsg
        } catch {
          return
        }
        handleServerMsg(msg)
      }
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      const ws = wsRef.current
      if (ws) {
        ws.onclose = null
        ws.close(1000, 'unmount')
      }
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 伺服器訊息分發 ────────────────────────────────────────────

  function handleServerMsg(msg: ServerMsg) {
    switch (msg.type) {
      case 'welcome': {
        setUser(msg.user)
        setStatus('ready')
        // 自動回到上次所在的房間（重新整理／重開瀏覽器）；沒有紀錄或未知就回大廳。
        // 大廳先加入（成員名單、預設保底），再把上次的房間也加入並切換過去。
        const savedRoom = loadSavedRoom()
        const target = savedRoom && savedRoom !== LOBBY_ID ? savedRoom : LOBBY_ID
        pendingRoomRef.current = target
        send({ type: 'room:join', roomId: LOBBY_ID })
        if (target !== LOBBY_ID) send({ type: 'room:join', roomId: target })
        break
      }
      case 'rooms':
        setRooms(msg.rooms)
        break
      case 'joined': {
        setMessages((prev) => ({ ...prev, [msg.roomId]: msg.messages }))
        setUnread((prev) => ({ ...prev, [msg.roomId]: 0 }))
        if (pendingRoomRef.current === msg.roomId || pendingRoomRef.current === 'create-needed') {
          pendingRoomRef.current = null
          activeRoomRef.current = msg.roomId
          setActiveRoomId(msg.roomId)
          // 記住現在的房間，重新整理後自動回來
          saveActiveRoom(msg.roomId)
        }
        break
      }
      case 'chat': {
        const { message } = msg
        setMessages((prev) => {
          const list = prev[message.roomId] ?? []
          if (list.some((m) => m.id === message.id)) return prev
          return { ...prev, [message.roomId]: [...list, message] }
        })
        if (activeRoomRef.current !== message.roomId || document.visibilityState !== 'visible') {
          setUnread((prev) => ({ ...prev, [message.roomId]: (prev[message.roomId] ?? 0) + 1 }))
        }
        setTyping((prev) => {
          const roomTyping = prev[message.roomId]
          if (!roomTyping) return prev
          return { ...prev, [message.roomId]: roomTyping.filter((t) => t.userId !== message.senderId) }
        })
        // 英文助教的英文回覆自動朗讀（正在看該房間時）
        if (shouldAutoSpeak(message, activeRoomRef.current, autoSpeakRef.current)) {
          speak(message.text)
        }
        break
      }
      case 'typing': {
        setTyping((prev) => {
          const list = (prev[msg.roomId] ?? []).filter((t) => t.userId !== msg.userId && t.until > Date.now())
          if (msg.typing) list.push({ userId: msg.userId, nickname: msg.nickname, until: Date.now() + TYPING_KEEP_MS })
          return { ...prev, [msg.roomId]: list }
        })
        break
      }
      case 'audio': {
        const url = toAudioUrl(msg.data)
        setAudio((prev) => {
          const next = { ...prev, [msg.messageId]: url }
          // 只保留最近 100 則的音訊 URL
          const keys = Object.keys(next)
          if (keys.length > 100) {
            for (const stale of keys.slice(0, keys.length - 100)) {
              URL.revokeObjectURL(next[stale])
              delete next[stale]
            }
          }
          return next
        })
        // 正在開啟自動朗讀且正在看該房間 → 優先播放 AI 語音（取代瀏覽器 TTS）
        if (msg.roomId === activeRoomRef.current && autoSpeakRef.current) {
          stopSpeak()
          void new Audio(url).play().catch(() => null)
        }
        break
      }
      case 'room:closed': {
        // 聊天室被解散（0 人或逾時）：回到大廳並顯示原因
        setMessages((prev) => ({ ...prev, [msg.roomId]: [] }))
        if (activeRoomRef.current === msg.roomId) {
          activeRoomRef.current = LOBBY_ID
          pendingRoomRef.current = LOBBY_ID
          setActiveRoomId(LOBBY_ID)
          saveActiveRoom(LOBBY_ID)
          send({ type: 'room:join', roomId: LOBBY_ID })
        }
        showStatusError(`🚪 ${msg.reason}`)
        break
      }
      case 'error':
        // 自動回上次的房間失敗（例如房間已解散）且還沒進任何房間 → 退回大廳
        if (!activeRoomRef.current) {
          pendingRoomRef.current = LOBBY_ID
          activeRoomRef.current = LOBBY_ID
          setActiveRoomId(LOBBY_ID)
          saveActiveRoom(LOBBY_ID)
          send({ type: 'room:join', roomId: LOBBY_ID })
        }
        showStatusError(msg.message)
        break
    }
  }

  // ── 正在輸入的自我清理 ────────────────────────────────────────

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setTyping((prev) => {
        let changed = false
        const next: Record<string, TypingUser[]> = {}
        for (const [roomId, list] of Object.entries(prev)) {
          const filtered = list.filter((t) => t.until > now)
          if (filtered.length !== list.length) changed = true
          next[roomId] = filtered
        }
        return changed ? next : prev
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // ── 對外的操作 ────────────────────────────────────────────────

  const login = useCallback(
    (nickname: string, color: string) => {
      profileRef.current = { nickname, color }
      // 記住登入資料，重新整理／重開瀏覽器後自動登回
      saveProfile(profileRef.current)
      sendHello()
    },
    [sendHello],
  )

  const openRoom = useCallback(
    (roomId: string) => {
      pendingRoomRef.current = roomId
      activeRoomRef.current = roomId
      setActiveRoomId(roomId)
      setUnread((prev) => ({ ...prev, [roomId]: 0 }))
      saveActiveRoom(roomId)
      send({ type: 'room:join', roomId })
    },
    [send],
  )

  const createRoom = useCallback(
    (name: string) => {
      // 標記為「等待建立完成」，joined 事件到達時切換過去
      pendingRoomRef.current = 'create-needed'
      send({ type: 'room:create', name })
    },
    [send],
  )

  const leaveRoom = useCallback(
    (roomId: string) => {
      send({ type: 'room:leave', roomId })
      // 離開目前房間時，回到大廳
      if (activeRoomRef.current === roomId) {
        openRoom(LOBBY_ID)
      }
      setUnread((prev) => ({ ...prev, [roomId]: 0 }))
    },
    [send, openRoom],
  )

  /** 登出：清除記錄的暱稱與房間、重置畫面，重連後停在登入畫面（可換人） */
  const logout = useCallback(() => {
    profileRef.current = null
    saveProfile(null)
    saveActiveRoom(null)
    setUser(null)
    setRooms([])
    setMessages({})
    setUnread({})
    setActiveRoomId(null)
    activeRoomRef.current = null
    pendingRoomRef.current = null
    tutorModeRef.current = false
    setTutorMode(false)
    mathModeRef.current = false
    setMathMode(false)
    const ws = wsRef.current
    if (ws) {
      // 讓 onclose 的自動重連走一遍：重連開啟後 profileRef 是 null → 顯示登入畫面
      ws.close(1000, 'logout')
    }
  }, [])

  const sendChat = useCallback(
    (text: string) => {
      const roomId = activeRoomRef.current
      if (!roomId) return
      send({ type: 'chat', roomId, text })
      lastTypingRef.current = 0
      send({ type: 'typing', roomId, typing: false })
    },
    [send],
  )

  const sendSticker = useCallback(
    (emoji: string) => {
      const roomId = activeRoomRef.current
      if (!roomId) return
      send({ type: 'chat', roomId, text: '', sticker: emoji })
    },
    [send],
  )

  const uploadAndSendImage = useCallback(
    async (file: File) => {
      const roomId = activeRoomRef.current
      if (!roomId) return
      if (!file.type.startsWith('image/')) {
        showStatusError('只支援圖片檔')
        return
      }
      if (file.size > 3 * 1024 * 1024) {
        showStatusError('圖片太大（上限 3MB）')
        return
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result))
          r.onerror = () => reject(new Error('read failed'))
          r.readAsDataURL(file)
        })
        const base64 = dataUrl.split(',')[1]
        const res = await fetch('/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: base64, mime: file.type }),
        })
        const json = (await res.json()) as { url?: string; error?: string }
        if (!res.ok || !json.url) {
          showStatusError(json.error ?? '上傳失敗')
          return
        }
        send({ type: 'chat', roomId, text: '', image: json.url })
      } catch {
        showStatusError('上傳失敗，再試一次')
      }
    },
    [send, showStatusError],
  )

  const notifyTyping = useCallback(() => {
    const roomId = activeRoomRef.current
    if (!roomId) return
    const now = Date.now()
    if (now - lastTypingRef.current < TYPING_SEND_THROTTLE_MS) return
    lastTypingRef.current = now
    send({ type: 'typing', roomId, typing: true })
  }, [send])

  const botToggle = useCallback(
    (roomId: string, enabled: boolean) => {
      send({ type: 'bot', roomId, enabled })
    },
    [send],
  )

  const toggleAutoSpeak = useCallback(() => {
    setAutoSpeak((prev) => {
      const next = !prev
      autoSpeakRef.current = next
      saveAutoSpeak(next)
      return next
    })
  }, [])

  /** 進入／離開英文教室：加入／離開獨立的「英文教室」房（朗讀與自動翻譯只有該房有） */
  const toggleTutor = useCallback(() => {
    if (tutorModeRef.current) {
      // 離開英文教室：伺服器會把我們退出房間，畫面切回大廳
      tutorModeRef.current = false
      setTutorMode(false)
      send({ type: 'tutor', enabled: false })
      if (activeRoomRef.current === ENGLISH_ROOM_ID) {
        pendingRoomRef.current = LOBBY_ID
        activeRoomRef.current = LOBBY_ID
        setActiveRoomId(LOBBY_ID)
        send({ type: 'room:join', roomId: LOBBY_ID })
      }
      return
    }
    // 進入英文教室：伺服器送 joined 後自動切換過去
    tutorModeRef.current = true
    setTutorMode(true)
    pendingRoomRef.current = ENGLISH_ROOM_ID
    send({ type: 'tutor', enabled: true })
  }, [send])

  /** 進入／離開數學教室：加入／離開獨立的「數學教室」房（數學助教＋小考只有該房有） */
  const toggleMathTutor = useCallback(() => {
    if (mathModeRef.current) {
      mathModeRef.current = false
      setMathMode(false)
      send({ type: 'tutor', enabled: false, subject: 'math' })
      if (activeRoomRef.current === MATH_ROOM_ID) {
        pendingRoomRef.current = LOBBY_ID
        activeRoomRef.current = LOBBY_ID
        setActiveRoomId(LOBBY_ID)
        send({ type: 'room:join', roomId: LOBBY_ID })
      }
      return
    }
    mathModeRef.current = true
    setMathMode(true)
    pendingRoomRef.current = MATH_ROOM_ID
    send({ type: 'tutor', enabled: true, subject: 'math' })
  }, [send])

  return {
    status,
    user,
    rooms,
    activeRoomId,
    messages,
    unread,
    typing,
    error,
    autoSpeak,
    tutorMode,
    mathMode,
    audio,
    login,
    logout,
    openRoom,
    createRoom,
    leaveRoom,
    sendChat,
    sendSticker,
    uploadAndSendImage,
    notifyTyping,
    botToggle,
    toggleAutoSpeak,
    toggleTutor,
    toggleMathTutor,
  }
}
