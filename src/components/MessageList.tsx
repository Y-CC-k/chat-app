import { BOT_EN_USER_ID, BOT_USER_ID, type ChatMessage, type ServerUser } from '@shared/protocol'
import { formatTime } from '../utils/format'
import { speak } from '../utils/speech'
import { Avatar } from './Avatar'

interface MessageListProps {
  messages: ChatMessage[]
  user: ServerUser
  audio: Record<string, string>
}

export function MessageList({ messages, user, audio }: MessageListProps) {
  const items: React.ReactNode[] = []
  let prev: ChatMessage | null = null

  for (const message of messages) {
    // 日期分隔線
    if (!prev || !isSameDay(prev.ts, message.ts)) {
      items.push(
        <div className="day-separator" key={`day-${message.id}`}>
          <span>{formatDay(message.ts)}</span>
        </div>,
      )
      prev = message
    }

    if (message.kind === 'system') {
      items.push(
        <div className="system-message" key={message.id}>
          {message.text}
        </div>,
      )
      continue
    }

    const own = message.senderId === user.userId
    const bubbleContent = (
      <>
        {message.sticker && <div className="msg-sticker">{message.sticker}</div>}
        {message.image && <img className="msg-image" src={message.image} alt="圖片" loading="lazy" />}
        {message.text && <div className="msg-text">{message.text}</div>}
      </>
    )
    if (own) {
      items.push(
        <div className="msg-row own" key={message.id}>
          <span className="msg-time">{formatTime(message.ts)}</span>
          <div className="bubble own-bubble">{bubbleContent}</div>
        </div>,
      )
    } else {
      items.push(
        <div className="msg-row other" key={message.id}>
          <Avatar name={message.senderName} color={message.color} size={36} />
          <div className="msg-other-main">
            <span className="msg-sender">
              {message.senderName}
              {message.senderId === BOT_USER_ID && <span className="bot-tag">🤖 機器人</span>}
              {message.senderId === BOT_EN_USER_ID && <span className="bot-tag en">🇺🇸 英文助教</span>}
            </span>
            <div className="msg-with-time">
              <div className="bubble other-bubble">{bubbleContent}</div>
              {message.senderId === BOT_EN_USER_ID && isMostlyEnglish(message.text) && (
                <button
                  type="button"
                  className="speak-btn"
                  title="朗讀"
                  onClick={() => {
                    const aiAudio = audio[message.id]
                    if (aiAudio) {
                      window.speechSynthesis?.cancel()
                      void new Audio(aiAudio).play().catch(() => null)
                    } else {
                      speak(message.text)
                    }
                  }}
                >
                  🔊
                </button>
              )}
              <span className="msg-time">{formatTime(message.ts)}</span>
            </div>
          </div>
        </div>,
      )
    }
  }

  return <div className="message-list">{items}</div>
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

/** 本檔案專用的英文判斷（排序:助教英文訊息才顯示 🔊） */
function isMostlyEnglish(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length
  return letters >= (text.match(/[\u4e00-\u9fff]/g) ?? []).length && letters > 0
}

function formatDay(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayMs = 86_400_000

  let label = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  if (startOfThatDay === startOfToday) label = '今天'
  else if (startOfToday - startOfThatDay === dayMs) label = '昨天'

  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return `${label} ${weekdays[date.getDay()]}`
}
