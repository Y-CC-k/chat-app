import { BOT_EN_USER_ID, type ChatMessage } from '@shared/protocol'

const AUTO_SPEAK_STORAGE_KEY = 'chat-autospeak'

/** 把伺服器送來的 base64 mp3 轉成可播放的音訊 URL */
export function toAudioUrl(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
}

/** 用瀏覽器內建語音合成朗讀（英文） */
export function speak(text: string): boolean {
  const synth = window.speechSynthesis
  if (!synth) return false
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'en-US'
  utterance.rate = 0.9
  utterance.pitch = 1
  synth.speak(utterance)
  return true
}

export function stopSpeak(): void {
  window.speechSynthesis?.cancel()
}

/** 讀取自動朗讀設定（預設開） */
export function loadAutoSpeak(): boolean {
  try {
    return localStorage.getItem(AUTO_SPEAK_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function saveAutoSpeak(value: boolean): void {
  try {
    localStorage.setItem(AUTO_SPEAK_STORAGE_KEY, value ? 'on' : 'off')
  } catch {
    // 忽略（隱私模式等）
  }
}

/** 收到英文助教的訊息時，判斷是否該朗讀 */
export function shouldAutoSpeak(message: ChatMessage, activeRoomId: string | null, enabled: boolean): boolean {
  return (
    enabled &&
    message.senderId === BOT_EN_USER_ID &&
    message.kind === 'chat' &&
    message.roomId === activeRoomId &&
    isMostlyEnglish(message.text)
  )
}

/** 判斷文字以英文為主（中文回覆不用英語音調唸） */
function isMostlyEnglish(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length
  return letters >= (text.match(/[\u4e00-\u9fff]/g) ?? []).length && letters > 0
}
