import { useState } from 'react'
import type { RoomSummary } from '@shared/protocol'
import { useChat } from './hooks/useChat'
import { LoginScreen } from './components/LoginScreen'
import { Sidebar } from './components/Sidebar'
import { ChatWindow } from './components/ChatWindow'
import { NewRoomModal } from './components/NewRoomModal'

export default function App() {
  const chat = useChat()
  const [modalOpen, setModalOpen] = useState(false)

  const activeRoom: RoomSummary | null = chat.rooms.find((room) => room.id === chat.activeRoomId) ?? null

  function handleCreateRoom(name: string) {
    chat.createRoom(name)
  }

  if (chat.status !== 'ready' || !chat.user) {
    return <LoginScreen connecting={chat.status === 'connecting'} onLogin={chat.login} />
  }

  return (
    <div className="app">
      <Sidebar
        user={chat.user}
        status={chat.status}
        rooms={chat.rooms}
        activeRoomId={chat.activeRoomId}
        unread={chat.unread}
        onSelectRoom={chat.openRoom}
        onNewRoom={() => setModalOpen(true)}
      />
      <ChatWindow
        user={chat.user}
        room={activeRoom}
        messages={chat.activeRoomId ? chat.messages[chat.activeRoomId] ?? [] : []}
        audio={chat.audio}
        typingUsers={chat.activeRoomId ? chat.typing[chat.activeRoomId] ?? [] : []}
        error={chat.error}
        onSend={chat.sendChat}
        onSendSticker={chat.sendSticker}
        onSendImage={chat.uploadAndSendImage}
        onTyping={chat.notifyTyping}
        onLeave={chat.leaveRoom}
        autoSpeak={chat.autoSpeak}
        onToggleAutoSpeak={chat.toggleAutoSpeak}
        tutorMode={chat.tutorMode}
        onToggleTutor={chat.toggleTutor}
      />
      <NewRoomModal open={modalOpen} onClose={() => setModalOpen(false)} onCreate={handleCreateRoom} />
    </div>
  )
}
