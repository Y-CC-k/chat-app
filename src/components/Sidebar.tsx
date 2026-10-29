import { LOBBY_ID, type RoomSummary, type ServerUser } from '@shared/protocol'
import type { ChatStatus } from '../hooks/useChat'
import { formatListTime } from '../utils/format'
import { Avatar } from './Avatar'

interface SidebarProps {
  user: ServerUser
  status: ChatStatus
  rooms: RoomSummary[]
  activeRoomId: string | null
  unread: Record<string, number>
  onSelectRoom: (roomId: string) => void
  onNewRoom: () => void
}

function lastPreview(rooms: RoomSummary[], roomId: string): { text: string; ts: number } | null {
  const room = rooms.find((r) => r.id === roomId)
  const last = room?.lastMessage
  if (!last) return null
  const prefix = last.senderName && last.text ? `${last.senderName}：` : ''
  const text = (prefix + last.text).slice(0, 30)
  return { text, ts: last.ts }
}

export function Sidebar({ user, status, rooms, activeRoomId, unread, onSelectRoom, onNewRoom }: SidebarProps) {
  return (
    <nav className="sidebar">
      <header className="sidebar-user">
        <Avatar name={user.nickname} color={user.color} />
        <div className="sidebar-user-info">
          <span className="sidebar-user-name">{user.nickname}</span>
          <span className="sidebar-status">
            <i className={`status-dot status-${status}`} />
            {status === 'ready'
              ? '連線中'
              : status === 'connecting'
                ? '連接中…'
                : status === 'login'
                  ? '登入中'
                  : '連線中斷'}
          </span>
        </div>
        <button type="button" className="icon-btn" title="新增聊天室" onClick={onNewRoom}>
          ＋
        </button>
      </header>

      <div className="sidebar-section">聊天</div>

      <ul className="room-list">
        {rooms.map((room) => {
          const unreadCount = unread[room.id] ?? 0
          const preview = lastPreview(rooms, room.id)
          const count = room.members.length
          return (
            <li key={room.id}>
              <button
                type="button"
                className={`room-item${room.id === activeRoomId ? ' active' : ''}`}
                onClick={() => onSelectRoom(room.id)}
              >
                <Avatar name={room.name} color={room.id === LOBBY_ID ? '#06c755' : '#3b82f6'} size={44} />
                <div className="room-item-main">
                  <div className="room-item-top">
                    <span className="room-item-name">{room.name}</span>
                    <span className="room-item-time">{preview ? formatListTime(preview.ts) : ''}</span>
                  </div>
                  <div className="room-item-bottom">
                    <span className="room-item-preview">{preview ? preview.text : '尚無訊息'}</span>
                    {unreadCount > 0 && <span className="unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
                  </div>
                  <div className="room-item-members">{count} 人</div>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
