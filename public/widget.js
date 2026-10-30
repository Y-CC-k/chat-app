/**
 * 線上聊天室 · 浮動機器人外掛（單檔、零依賴）
 * ================================================================
 * 在任何網頁貼上這一行即可掛上「小幫手」浮動對話：
 *
 *   <script src="https://classroom-chat-u1td.onrender.com/widget.js" defer></script>
 *
 * 進階設定（用 data-* 或 window.__CHAT_WIDGET__）：
 *   data-server    : WebSocket 位址（預設：widget.js 來源網站的 /ws，自動 wss/ws）
 *   data-nickname  : 顯示暱稱（預設「訪客」；使用者可自行改名）
 *   data-room      : 指定加入的房間 ID（預設空 = 自動開私人「小幫手對話」房）
 *   data-bot       : 機器人名字（預設「小幫手」）
 *   data-accent    : 主題色（預設 LINE 綠 #06c755）
 *   data-position  : 「right」（預設）或「left」
 *
 * API：window.ChatWidget.open() / .close() / .toggle() / .config({...})
 */
(function () {
  'use strict'
  if (window.__chatWidgetLoaded) return
  window.__chatWidgetLoaded = true

  // ── 設定 ─────────────────────────────────────────────────────────
  const script = document.currentScript
  const dataAttrs = (script && script.dataset) || {}
  const globalCfg = window.__CHAT_WIDGET__ || {}

  function scriptOrigin() {
    try {
      if (script && script.src) return new URL(script.src).origin
    } catch (_) { /* ignore */ }
    return window.location.origin
  }

  function defaultServer() {
    const origin = scriptOrigin()
    return (origin.indexOf('https:') === 0 ? 'wss://' : 'ws://') + origin.replace(/^https?:\/\//, '') + '/ws'
  }

  const cfg = {
    server: String(dataAttrs.server || globalCfg.server || ''),
    nickname: String(dataAttrs.nickname || globalCfg.nickname || ''),
    room: String(dataAttrs.room || globalCfg.room || ''),
    bot: String(dataAttrs.bot || globalCfg.bot || '小幫手'),
    accent: String(dataAttrs.accent || globalCfg.accent || '#06c755'),
    position: String(dataAttrs.position || globalCfg.position || 'right'),
    image: String(dataAttrs.image || globalCfg.image || ''),
    title: String(dataAttrs.title || globalCfg.title || '小幫手'),
    greeting: String(
      dataAttrs.greeting || globalCfg.greeting ||
      '你好！我是小幫手 🤖 有什麼想問的都可以直接說～（一次最多 50 字）',
    ),
  }
  if (!cfg.server) cfg.server = defaultServer()

  const LS_NICK = 'chat-widget-nickname'
  const LS_NUID = 'chat-widget-nuid'
  function savedNickname() {
    try { return localStorage.getItem(LS_NICK) || '' } catch (_) { return '' }
  }
  function saveNickname(n) {
    try { localStorage.setItem(LS_NICK, n) } catch (_) { /* ignore */ }
  }
  // 每台瀏覽器一個穩定編號（100–999，存在 localStorage 不會變），
  // 讓同一暱稱的多位訪客視為不同使用者（每人 1 間私人房的限額才不會互相擋）
  function visitorNumber() {
    try {
      let n = localStorage.getItem(LS_NUID)
      if (!n || !/^\d{3}$/.test(n)) {
        n = String(100 + Math.floor(Math.random() * 900))
        localStorage.setItem(LS_NUID, n)
      }
      return n
    } catch (_) { return String(100 + (Date.now() % 900)) }
  }

  // ── 樣式（全部放進 shadow root，不污染宿主頁） ─────────────────────
  const CSS = `
:host { all: initial; font-family: system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif; }
* { box-sizing: border-box; margin: 0; }
button { font: inherit; cursor: pointer; border: 0; background: none; }
.fab {
  position: fixed; bottom: 20px; ${cfg.position === 'left' ? 'left' : 'right'}: 20px;
  width: 60px; height: 60px; border-radius: 50%;
  background: ${cfg.accent}; color: #fff; font-size: 28px; line-height: 1;
  box-shadow: 0 4px 18px rgba(0,0,0,.25); z-index: 2147483001;
  display: flex; align-items: center; justify-content: center;
  transition: transform .15s;
  overflow: hidden; padding: 0;
}
.fab:hover { transform: scale(1.06); }
.fab > img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; background: #fff; }
.badge {
  position: absolute; top: -4px; right: -4px; background: #ef4444; color: #fff;
  min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  font-size: 12px; font-weight: 700; display: none; align-items: center; justify-content: center;
}
.panel {
  position: fixed; bottom: 96px; ${cfg.position === 'left' ? 'left' : 'right'}: 20px;
  width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 140px));
  background: #f2f6f9; border-radius: 18px; overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,.3); z-index: 2147483002;
  display: none; flex-direction: column; color: #111;
}
.panel.open { display: flex; animation: pop .18s ease-out; }
@keyframes pop { from { opacity: 0; transform: translateY(12px) scale(.97); } to { opacity: 1; transform: none; } }
.head {
  background: ${cfg.accent}; color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 10px; flex: 0 0 auto;
}
.head .avatar { width: 38px; height: 38px; border-radius: 50%; background: rgba(255,255,255,.25); display: flex; align-items: center; justify-content: center; font-size: 20px; flex: 0 0 auto; }
.head .title { font-size: 16px; font-weight: 700; }
.head .sub { font-size: 12px; opacity: .85; margin-top: 2px; }
.head .spacer { flex: 1; }
.head button { color: #fff; font-size: 18px; padding: 4px 6px; border-radius: 8px; opacity: .9; }
.head button:hover { background: rgba(255,255,255,.15); }
.list { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.msg { display: flex; gap: 8px; max-width: 100%; }
.msg .bubble {
  background: #fff; border-radius: 4px 14px 14px 14px; padding: 9px 12px;
  font-size: 14px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  max-width: 76%; box-shadow: 0 1px 2px rgba(0,0,0,.06);
}
.msg .name { font-size: 11px; color: #8aa; margin: 0 0 3px 2px; }
.msg.self { justify-content: flex-end; }
.msg.self .bubble { background: ${cfg.accent}; color: #fff; border-radius: 14px 4px 14px 14px; }
.msg.system { justify-content: center; }
.msg.system .bubble { background: none; box-shadow: none; color: #99a6b0; font-size: 12px; padding: 2px 6px; }
.status { font-size: 12px; color: #99a6b0; padding: 0 14px 8px; min-height: 18px; }
.footer { display: flex; gap: 8px; padding: 10px 12px; background: #fff; border-top: 1px solid #e5e9ee; flex: 0 0 auto; }
.footer input {
  flex: 1; border: 1px solid #dde3e8; border-radius: 20px; padding: 9px 14px;
  font: inherit; font-size: 14px; outline: none; min-width: 0; background: #fff; color: #111;
}
.footer input:focus { border-color: ${cfg.accent}; }
.footer .count { flex: 0 0 auto; font-size: 11px; color: #8aa; min-width: 42px; text-align: right; align-self: center; }
.footer .count.limit { color: #ef4444; font-weight: 700; }
.footer .send {
  background: ${cfg.accent}; color: #fff; width: 40px; height: 40px; flex: 0 0 auto;
  border-radius: 50%; font-size: 17px; align-self: center; display: flex; align-items: center; justify-content: center;
}
.footer .send:disabled { opacity: .45; }
  .sticker-panel { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px; background: #f7f9fc; border-top: 1px solid #e5e9ee; max-height: 120px; overflow-y: auto; }
  .sticker-btn { background: none; border: none; font-size: 22px; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
  .sticker-btn:hover { background: #eef2f7; }
  .bubble.sticker { font-size: 44px; line-height: 1; background: transparent; padding: 0; box-shadow: none; }
  .msg-image { max-width: 160px; max-height: 160px; border-radius: 10px; display: block; margin: 2px 0; }
  .bubble .msg-text { margin-top: 4px; font-size: 14px; }
@media (max-width: 480px) {
  .panel { bottom: 0; height: 100vh; width: 100vw; border-radius: 0; }
  .fab { bottom: 16px; }
}
`.trim()

  // ── 標記 ─────────────────────────────────────────────────────────
  const host = document.createElement('div')
  host.style.cssText = 'all:initial'
  const root = host.attachShadow({ mode: 'open' })

  function el(tag, className, text) {
    const e = document.createElement(tag)
    if (className) e.className = className
    if (text != null) e.textContent = text
    return e
  }

  const styleTag = el('style')
  styleTag.textContent = CSS

  // FAB／標頭頭像的內容：有 data-image 用圖片，否則用 emoji
  const fab = el('button', 'fab')
  const badge = el('span', 'badge')
  function fabContent(closed) {
    fab.textContent = ''
    if (cfg.image) {
      const img = document.createElement('img')
      img.src = cfg.image
      img.alt = '打開小幫手'
      img.loading = 'eager'
      img.onerror = function () {
        fab.textContent = closed ? '💬' : '✕'
      }
      fab.appendChild(img)
      if (!closed) {
        // 打開狀態：圖上疊一個半透明 ✕ 表示可收回
        const over = el('span', 'fab-x', '✕')
        over.style.cssText =
          'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(0,0,0,.55);color:#fff;font-size:22px;border-radius:50%;z-index:1'
        fab.appendChild(over)
      }
    } else {
      fab.textContent = closed ? '💬' : '✕'
    }
    fab.appendChild(badge)
  }
  fab.setAttribute('aria-label', '打開小幫手')
  fabContent(true)

  const panel = el('div', 'panel')
  const head = el('div', 'head')
  const avatar = el('div', 'avatar', cfg.image ? '' : '🤖')
  if (cfg.image) {
    const aimg = document.createElement('img')
    aimg.src = cfg.image
    aimg.alt = ''
    aimg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;background:#fff'
    avatar.appendChild(aimg)
  }
  const titleBox = el('div')
  titleBox.appendChild(el('div', 'title', cfg.title))
  const sub = el('div', 'sub', '線上客服 · 隨時回答')
  titleBox.appendChild(sub)
  const spacer = el('div', 'spacer')
  const closeBtn = el('button')
  closeBtn.textContent = '✕'
  closeBtn.addEventListener('click', () => api.close())
  head.append(avatar, titleBox, spacer, closeBtn)

  const list = el('div', 'list')
  const status = el('div', 'status')
  const footer = el('div', 'footer')
  const MAX_LEN = 50 // 訪客提問一次最多 50 字
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '輸入問題…（Enter 送出，最多 50 字）'
  input.maxLength = MAX_LEN
  const counter = el('span', 'count', '0/' + MAX_LEN)
  const stickerBtn = el('button', 'send', '😊')
  stickerBtn.title = '貼圖'
  stickerBtn.style.background = '#fff'
  stickerBtn.style.color = cfg.accent
  stickerBtn.style.border = '1px solid #e5e9ee'
  const imageBtn = el('button', 'send', '📎')
  imageBtn.title = '上傳圖片'
  imageBtn.style.background = '#fff'
  imageBtn.style.color = cfg.accent
  imageBtn.style.border = '1px solid #e5e9ee'
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif'
  fileInput.style.display = 'none'
  const sendBtn = el('button', 'send', '➤')
  sendBtn.disabled = true
  footer.append(stickerBtn, imageBtn, fileInput, input, counter, sendBtn)
  panel.append(head, list, status, footer)

  // 貼圖面板
  const STICKERS = ['😀','😂','😍','🤔','👍','❤️','🎉','🔥','⭐','🚀','🐱','🐶','💯','🙏','👏','😭']
  const stickerPanel = el('div', 'sticker-panel')
  stickerPanel.style.display = 'none'
  for (const s of STICKERS) {
    const b = el('button', 'sticker-btn', s)
    b.addEventListener('click', () => { sendSticker(s); stickerPanel.style.display = 'none' })
    stickerPanel.appendChild(b)
  }
  panel.insertBefore(stickerPanel, footer)

  root.append(styleTag, fab, panel)

  // ── 狀態與 WebSocket ─────────────────────────────────────────────
  let ws = null
  let myRoomId = null
  let myUserId = ''
  let state = 'idle' // idle | connecting | ready | failed
  let reconnectAttempts = 0
  let reconnectTimer = null
  // 暱稱：有 data-nickname → 底名 + 瀏覽器編號（穩定）；沒有則用上次存的或「訪客+編號」
  const VNUID = visitorNumber()
  let nickname = savedNickname() || cfg.nickname || '訪客'
  if (cfg.nickname) {
    nickname = cfg.nickname.replace(/-\d{3}$/, '') + '-' + VNUID
    saveNickname(nickname)
  } else {
    nickname = savedNickname() || '訪客-' + VNUID
    saveNickname(nickname)
  }
  let openedManually = false
  let unread = 0
  let replyWatchdog = null // 送訊息後 30 秒無回覆的提示計時器
  let recreateTimer = null // 開房失敗的自動重試計時器
  let createRetries = 0 // 已重試次數

  function setState(s, note) {
    state = s
    status.textContent = note || ''
    refreshComposer()
  }
  function refreshComposer() {
    const active = state === 'ready'
    input.disabled = !active
    sendBtn.disabled = !active || !input.value.trim()
    counter.textContent = input.value.length + '/' + MAX_LEN
    counter.className = 'count' + (input.value.length >= MAX_LEN ? ' limit' : '')
    if (state === 'ready') status.textContent = ''
  }

  function addMessage(m) {
    if (m.kind === 'system') return // 加入／離開／解散等系統訊息：私人小幫手情境不需要，不顯示
    const row = el('div', 'msg' + (m.senderId === myUserId ? ' self' : ''))
    const nameLine = m.senderId === myUserId ? null : el('div', 'name', m.senderName)
    const bubble = el('div', 'bubble')
    if (m.sticker) {
      bubble.classList.add('sticker')
      bubble.textContent = m.sticker
    } else if (m.image) {
      const img = document.createElement('img')
      img.src = m.image
      img.alt = '圖片'
      img.className = 'msg-image'
      img.loading = 'lazy'
      bubble.appendChild(img)
      if (m.text) {
        const t = el('div', 'msg-text', m.text)
        bubble.appendChild(t)
      }
    } else {
      bubble.textContent = m.text
    }
    if (nameLine) {
      const wrap = el('div')
      wrap.append(nameLine, bubble)
      row.appendChild(wrap)
    } else {
      row.appendChild(bubble)
    }
    list.appendChild(row)
    list.scrollTop = list.scrollHeight
    if (!panel.classList.contains('open')) {
      unread += 1
      badge.textContent = String(unread > 99 ? '99+' : unread)
      badge.style.display = 'flex'
    }
  }

  function resetList() {
    list.textContent = ''
    addMessage({ kind: 'chat', senderId: '', senderName: cfg.bot, ts: 0, text: cfg.greeting })
  }

  /** 先打一發 healthz「喚醒」休眠中的免費雲端伺服器（最多 18 秒），再連 WebSocket */
  function wakeThenConnect() {
    if (!state || state === 'idle' || state === 'failed') return // 期間被關掉了
    fetch(scriptOrigin() + '/healthz', { signal: AbortSignal.timeout(18000) })
      .catch(() => {})
      .then(() => {
        if (!state || state === 'idle' || state === 'failed') return
        openSocket()
      })
  }
  /** 正式入口：連線（先喚醒伺服器再開 WebSocket） */
  function connect() {
    if (ws && (state === 'connecting' || state === 'ready')) return
    clearTimeout(reconnectTimer)
    setState('connecting', '正在喚醒伺服器…')
    wakeThenConnect()
  }
  function openSocket() {
    try { ws = new WebSocket(cfg.server) } catch (e) {
      setState('failed', '連線失敗，請確認網址')
      return
    }
    let helloSent = false
    ws.onopen = () => {
      helloSent = false
      reconnectAttempts = 0
      ws.send(JSON.stringify({
        type: 'hello',
        nickname,
        // widget 訪客不進大廳：大廳的聊天／系統訊息完全不會流入外掛
        skipLobby: true,
        color: ['#06c755', '#3b82f6', '#f97316', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#eab308'][(Date.now() % 232) % 8] ?? '#06c755',
      }))
    }
    ws.onmessage = (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch (_) { return }
      switch (msg.type) {
        case 'welcome': {
          if (helloSent) return
          helloSent = true
          myUserId = msg.user.userId
          if (!savedNickname() || cfg.nickname) saveNickname(nickname)
          setState('connecting', '開房中…')
          startRoom()
          return
        }
        case 'joined': {
          myRoomId = msg.roomId
          createRetries = 0
          clearTimeout(recreateTimer)
          myRoomId = msg.roomId
          resetList()
          for (const m of msg.messages.slice(-30)) addMessage(m)
          //
          setState('ready')
          return
        }
        case 'chat': {
          if (msg.message.roomId !== myRoomId) return
          // 隱藏機器人自動答詢的開／關確認訊息（widget 私聊情境不需要）
          if (msg.message.senderName === cfg.bot && msg.message.text.indexOf('自動答詢') >= 0) return
          clearTimeout(replyWatchdog) // 收到訊息（含自己的同房訊息）即解除「無回覆」提示
          addMessage(msg.message)
          return
        }
        case 'typing': {
          if (msg.roomId !== myRoomId || msg.userId === myUserId) return
          status.textContent = msg.typing ? `${msg.nickname} 正在輸入…` : ''
          return
        }
        case 'error': {
          status.textContent = msg.message
          // 房間還沒開成功（開房中失敗）：一段時間後自動重試，絕不把訊息送去大廳
          if (!myRoomId && ws && createRetries < 3) {
            createRetries += 1
            clearTimeout(recreateTimer)
            recreateTimer = setTimeout(startRoom, 1800)
          }
          return
        }
        case 'room:closed': {
          if (msg.roomId !== myRoomId) return
          myRoomId = null
          addMessage({ kind: 'system', ts: 0, text: msg.reason })
          startRoom()
          return
        }
        default: return
      }
    }
    ws.onclose = () => {
      ws = null
      const retryAfter = Math.min(1000 * Math.pow(1.6, reconnectAttempts++), 15000)
      if (openedManually) {
        setState('connecting', `連線中斷，${Math.round(retryAfter / 1000)} 秒後重試…`)
        reconnectTimer = setTimeout(connect, retryAfter)
      } else {
        setState('idle')
      }
    }
    ws.onerror = () => { /* onclose 會接手 */ }
    function startRoom() {
      if (cfg.room) {
        ws.send(JSON.stringify({ type: 'room:join', roomId: cfg.room }))
      } else {
        ws.send(JSON.stringify({ type: 'room:create', name: `${cfg.bot}想聊聊` }))
      }
    }
  }

  function disconnect() {
    clearTimeout(reconnectTimer)
    clearTimeout(replyWatchdog)
    clearTimeout(recreateTimer)
    if (ws) {
      if (myRoomId) {
        try { ws.send(JSON.stringify({ type: 'room:leave', roomId: myRoomId })) } catch (_) { /* ignore */ }
      }
      ws.close()
      ws = null
    }
    myRoomId = null
    myUserId = ''
    setState('idle')
  }

  function sendText() {
    const text = input.value.trim()
    if (!text || state !== 'ready' || !ws || ws.readyState !== 1) {
      if (text) status.textContent = state === 'connecting' ? '連線中…請等幾秒再送一次' : '連線已斷，再送一次即可重連'
      return
    }
    if (!myRoomId) {
      status.textContent = '房間還在準備中，1～2 秒後再送一次'
      return
    }
    try {
      ws.send(JSON.stringify({ type: 'chat', roomId: myRoomId, text: text.slice(0, MAX_LEN) }))
    } catch (_) {
      status.textContent = '訊息送不出去，再送一次即可重連'
      return
    }
    input.value = ''
    refreshComposer()
    // 30 秒沒收到任何回覆時給提示（LLM 服務全斷／伺服器休眠時不會音訊全無）
    clearTimeout(replyWatchdog)
    replyWatchdog = setTimeout(() => {
      if (state === 'ready') {
        status.textContent = '小幫手想了很久還沒回…再送一次試試（若常常如此代表 AI 服務忙碌）'
      }
    }, 30000)
  }

  stickerBtn.addEventListener('click', () => {
    stickerPanel.style.display = stickerPanel.style.display === 'none' ? 'flex' : 'none'
  })
  imageBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0]
    fileInput.value = ''
    if (f) sendImageFile(f)
  })
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items
    if (!items) return
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) { e.preventDefault(); sendImageFile(f); return }
      }
    }
  })
  input.addEventListener('input', refreshComposer)
  function sendSticker(emoji) {
    if (state !== 'ready' || !ws || ws.readyState !== 1 || !myRoomId) return
    try { ws.send(JSON.stringify({ type: 'chat', roomId: myRoomId, text: '', sticker: emoji })) } catch (_) { status.textContent = '訊息送不出去，再送一次即可重連'; return }
    clearTimeout(replyWatchdog)
    replyWatchdog = setTimeout(() => { if (state === 'ready') status.textContent = '小幫手想了很久還沒回…再送一次試試' }, 30000)
  }
  async function sendImageFile(file) {
    if (state !== 'ready' || !ws || ws.readyState !== 1 || !myRoomId) { status.textContent = '連線中…請等幾秒再送一次'; return }
    if (!file.type || !file.type.startsWith('image/')) { status.textContent = '只支援圖片檔'; return }
    if (file.size > 3 * 1024 * 1024) { status.textContent = '圖片太大（上限 3MB）'; return }
    status.textContent = '上傳圖片中…'
    try {
      const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file) })
      const base64 = String(dataUrl).split(',')[1]
      const res = await fetch(scriptOrigin() + '/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: base64, mime: file.type }) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.url) { status.textContent = json.error || '上傳失敗'; return }
      ws.send(JSON.stringify({ type: 'chat', roomId: myRoomId, text: '', image: json.url }))
      status.textContent = ''
      clearTimeout(replyWatchdog)
      replyWatchdog = setTimeout(() => { if (state === 'ready') status.textContent = '小幫手想了很久還沒回…再送一次試試' }, 30000)
    } catch (e) { status.textContent = '上傳失敗，再試一次' }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendText()
    }
  })
  sendBtn.addEventListener('click', sendText)

  // ── 外部 API ─────────────────────────────────────────────────────
  const api = {
    open() {
      openedManually = true
      unread = 0
      badge.style.display = 'none'
      panel.classList.add('open')
      fabContent(false)
      if (state === 'idle' || state === 'failed') connect()
      else if (ws && ws.readyState === 1 && !myRoomId) startRoom()
      input.focus()
    },
    close() {
      openedManually = false
      panel.classList.remove('open')
      fabContent(true)
      disconnect()
    },
    toggle() {
      if (panel.classList.contains('open')) api.close()
      else api.open()
    },
    config(partial) {
      Object.assign(cfg, partial || {})
      return { ...cfg }
    },
  }
  window.ChatWidget = api

  fab.addEventListener('click', api.toggle)

  function mount() {
    if (document.body) {
      document.body.appendChild(host)
    } else {
      new MutationObserver((_m, obs) => {
        if (document.body) {
          document.body.appendChild(host)
          obs.disconnect()
        }
      }).observe(document.documentElement, { childList: true })
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()
