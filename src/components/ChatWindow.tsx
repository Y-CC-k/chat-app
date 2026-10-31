import { useEffect, useRef } from 'react'
import { ENGLISH_ROOM_ID, LOBBY_ID, MATH_ROOM_ID, type ChatMessage, type RoomSummary, type ServerUser } from '@shared/protocol'
import type { TypingUser } from '../hooks/useChat'
import { Avatar } from './Avatar'
import { MessageList } from './MessageList'
import { Composer } from './Composer'

interface ChatWindowProps {
  user: ServerUser
  room: RoomSummary | null
  messages: ChatMessage[]
  audio: Record<string, string>
  typingUsers: TypingUser[]
  error: string | null
  autoSpeak: boolean
  tutorMode: boolean
  mathMode: boolean
  onSend: (text: string) => void
  onSendSticker: (emoji: string) => void
  onSendImage: (file: File) => void
  onTyping: () => void
  onLeave: (roomId: string) => void
  onToggleAutoSpeak: () => void
  onToggleTutor: () => void
  onToggleMathTutor: () => void
}

export function ChatWindow({
  user,
  room,
  messages,
  audio,
  typingUsers,
  error,
  autoSpeak,
  tutorMode,
  mathMode,
  onSend,
  onSendSticker,
  onSendImage,
  onTyping,
  onLeave,
  onToggleAutoSpeak,
  onToggleTutor,
  onToggleMathTutor,
}: ChatWindowProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 新訊息時自動捲至底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, room?.id, typingUsers.length])

  if (!room) {
    return (
      <div className="chat-window empty">
        <p>選擇左邊的聊天室開始對話</p>
      </div>
    )
  }

  const typingHint =
    typingUsers.length > 0 ? `${typingUsers.map((t) => t.nickname).slice(0, 3).join('、')} 正在輸入…` : null

  return (
    <main className="chat-window">
      <header className="chat-header">
        <div className="chat-header-info">
          <h2>{room.name}</h2>
          <span className="chat-header-sub">{room.members.length} 人</span>
        </div>
        <div className="chat-header-members">
          {room.members.slice(0, 5).map((member) => (
            <span key={member.userId} className="member-chip" title={member.nickname}>
              <Avatar name={member.nickname} color={member.color} size={22} />
            </span>
          ))}
          {room.members.length > 5 && <span className="member-more">+{room.members.length - 5}</span>}
          {room.id === ENGLISH_ROOM_ID && (
            <button
              type="button"
              className={`bot-toggle speak-toggle${autoSpeak ? ' on' : ''}`}
              title={autoSpeak ? '關閉朗讀' : '開啟朗讀'}
              onClick={onToggleAutoSpeak}
            >
              🔊 朗讀{autoSpeak ? '開' : '關'}
            </button>
          )}
          {room.id !== ENGLISH_ROOM_ID ? (
            <button
              type="button"
              className={tutorMode ? 'bot-toggle tutor-mode on' : 'bot-toggle tutor-mode'}
              title="加入英文教室：翻譯＋朗讀（全聊天室只有這間有）"
              onClick={onToggleTutor}
            >
              🇺🇸 加入英文教室
            </button>
          ) : (
            <button
              type="button"
              className="bot-toggle tutor-mode on"
              title="離開英文教室"
              onClick={onToggleTutor}
            >
              🇺🇸 英文教室中 · 離開
            </button>
          )}
          {room.id !== MATH_ROOM_ID && room.id !== ENGLISH_ROOM_ID && (
            <button
              type="button"
              className={mathMode ? 'bot-toggle math-mode on' : 'bot-toggle math-mode'}
              title="加入數學教室：數學助教引導＋自動出題小考"
              onClick={onToggleMathTutor}
            >
              ➗ 加入數學教室
            </button>
          )}
          {room.id === MATH_ROOM_ID && (
            <button
              type="button"
              className="bot-toggle math-mode on"
              title="離開數學教室"
              onClick={onToggleMathTutor}
            >
              ➗ 數學教室中 · 離開
            </button>
          )}
        </div>
        {room.id !== LOBBY_ID && (
          <button type="button" className="btn-ghost leave-btn" onClick={() => onLeave(room.id)}>
            退出房間
          </button>
        )}
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        <MessageList messages={messages} user={user} audio={audio} />
      </div>

      {error && <div className="error-banner">{error}</div>}

      {tutorMode && room.id === ENGLISH_ROOM_ID && (
        <div className="tutor-banner">
          🇺🇸 英文教室中：每句訊息都會朗讀，你說的話英文助教會幫你翻譯（點上方按鈕離開）
        </div>
      )}

      {mathMode && room.id === MATH_ROOM_ID && (
        <div className="tutor-banner math-banner">
          ➗ 數學教室中：直接問數學題，數學助教會一步一步引導你想出答案；輸入 /數學小考 開始小考
        </div>
      )}

      <Composer typingHint={typingHint} onSend={onSend} onSendSticker={onSendSticker} onSendImage={onSendImage} onTyping={onTyping} tutorMode={tutorMode} mathMode={room.id === MATH_ROOM_ID} />
    </main>
  )
}
