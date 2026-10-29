import { useRef, useState } from 'react'
import { MAX_TEXT_LENGTH } from '@shared/protocol'

const EMOJIS = [
  '😀','😁','😂','🤣','😊','😍','😘','😜','😎','🤔',
  '😏','😢','😭','😡','🙏','👍','👎','👏','💪','🤝',
  '❤️','💔','🎉','🥳','🔥','✨','⭐','💯','☀️','🌙',
  '🐱','🐶','🐰','🐻','🐯','🐮','🐷','🐸','🚀','🍀',
]

interface ComposerProps {
  typingHint: string | null
  tutorMode: boolean
  onSend: (text: string) => void
  onTyping: () => void
}

/** 訊息輸入列：文字方塊、表情符號、送出 */
export function Composer({ typingHint, tutorMode, onSend, onTyping }: ComposerProps) {
  const [text, setText] = useState('')
  const [showEmoji, setShowEmoji] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  function update(next: string) {
    setText(next)
    onTyping()
  }

  function send() {
    const value = text.trim()
    if (!value) return
    onSend(value)
    setText('')
    setShowEmoji(false)
    inputRef.current?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  function insertEmoji(emoji: string) {
    const el = inputRef.current
    if (!el) {
      update(text + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const next = text.slice(0, start) + emoji + text.slice(end)
    update(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + emoji.length
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="composer-wrap">
      <div className="typing-hint">{typingHint}</div>
      <div className="composer">
        {showEmoji && (
          <div className="emoji-panel">
            {EMOJIS.map((emoji) => (
              <button type="button" key={emoji} className="emoji-btn" onClick={() => insertEmoji(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className={`icon-btn emoji-toggle${showEmoji ? ' active' : ''}`}
          title="表情符號"
          onClick={() => setShowEmoji((prev) => !prev)}
        >
          😊
        </button>
        <textarea
          ref={inputRef}
          className="composer-input"
          value={text}
          placeholder={
            tutorMode
              ? '輸入中文，英文助教會自動翻譯成英文並唸出…'
              : '輸入訊息…（Enter 送出，Shift+Enter 換行）'
          }
          rows={1}
          maxLength={MAX_TEXT_LENGTH}
          onChange={(event) => update(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="button" className="send-btn" title="送出" disabled={!text.trim()} onClick={send}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M2.4 11.06 21.2 2.7a.5.5 0 0 1 .66.68L13.4 21.6a.5.5 0 0 1-.93-.05l-2.3-6.6a2 2 0 0 0-1.22-1.23l-6.5-2.3a.5.5 0 0 1-.05-.36z" />
          </svg>
        </button>
      </div>
      {text.length > 0 && <span className="char-count">{text.length}/{MAX_TEXT_LENGTH}</span>}
    </div>
  )
}
