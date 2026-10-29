import { useState } from 'react'
import { AVATAR_COLORS, MAX_NICKNAME_LENGTH } from '@shared/protocol'

interface LoginScreenProps {
  connecting: boolean
  onLogin: (nickname: string, color: string) => void
}

/** 登入畫面：填暱稱、選頭像顏色 */
export function LoginScreen({ connecting, onLogin }: LoginScreenProps) {
  const [nickname, setNickname] = useState('')
  const [color, setColor] = useState<string>(AVATAR_COLORS[0])

  const trimmed = nickname.trim()
  const canSubmit = !connecting && trimmed.length >= 1 && trimmed.length <= MAX_NICKNAME_LENGTH

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (canSubmit) onLogin(trimmed, color)
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-logo">
          <svg viewBox="0 0 32 32" width="64" height="64" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#06c755" />
            <path
              d="M16 7c-5.5 0-10 3.6-10 8 0 2.6 1.5 5 3.9 6.4-.1.8-.5 2-1.4 2.8 0 0 2.4-.3 4-1.5 1.1.3 2.3.5 3.5.5 5.5 0 10-3.6 10-8.2S21.5 7 16 7z"
              fill="#fff"
            />
          </svg>
        </div>
        <h1>線上聊天室</h1>
        <p className="login-hint">和大家一起聊天吧！</p>

        <label className="login-label" htmlFor="nickname">
          暱稱
        </label>
        <input
          id="nickname"
          className="login-input"
          value={nickname}
          maxLength={MAX_NICKNAME_LENGTH}
          placeholder="請輸入你的暱稱"
          autoFocus
          onChange={(event) => setNickname(event.target.value)}
        />

        <span className="login-label">頭像顏色</span>
        <div className="login-colors">
          {AVATAR_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              className={`color-swatch${c === color ? ' active' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`選擇顏色 ${c}`}
            />
          ))}
        </div>

        <button className="login-submit" type="submit" disabled={!canSubmit}>
          {connecting ? '連線中…' : '開始聊天'}
        </button>
      </form>
    </div>
  )
}
