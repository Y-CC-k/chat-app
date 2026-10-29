import { useEffect, useState } from 'react'
import { MAX_ROOM_NAME_LENGTH } from '@shared/protocol'

interface NewRoomModalProps {
  open: boolean
  onClose: () => void
  onCreate: (name: string) => void
}

export function NewRoomModal({ open, onClose, onCreate }: NewRoomModalProps) {
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) setName('')
  }, [open])

  if (!open) return null

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const value = name.trim()
    if (!value) return
    onCreate(value)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h2>建立聊天室</h2>
        <p className="modal-hint">任何人都可以從清單加入你的聊天室。</p>
        <p className="modal-hint">⏳ 每人限建 1 間；聊天室存活 1 小時，且沒有人時會立即解散。</p>
        <input
          className="login-input"
          value={name}
          maxLength={MAX_ROOM_NAME_LENGTH}
          placeholder="輸入聊天室名稱"
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={!name.trim()}>
            建立
          </button>
        </div>
      </form>
    </div>
  )
}
