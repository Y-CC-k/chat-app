import { BOT_EN_USER_ID, type ChatMessage } from '@shared/protocol'

const AUTO_SPEAK_STORAGE_KEY = 'chat-autospeak'

/** 把伺服器送來的 base64 mp3 轉成可播放的音訊 URL */
export function toAudioUrl(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
}

/** speak() 的取消掛鉤清單：stopSpeak() 時把還在等待的朗讀也取消 */
let stopSpeakHooks: Array<() => void> = []

/** 等引擎空閒→再呼吸一下→才開始唸。
 *
 * Chrome 已知問題：引擎釋放沒完成就 speak() 會把開頭幾個字吃掉，
 * 第一次朗讀正常、連續朗讀第二句起尤其明顯（引擎剛唸完上一句還沒 idle）。
 * 所以先輪詢 synth.speaking/pending 等引擎空閒，再呼吸 IDLE_BREATHE_MS 才 speak()。
 */
function beginWhenIdle(synth: SpeechSynthesis, utterance: SpeechSynthesisUtterance): void {
  const IDLE_POLL_MS = 60
  const IDLE_BREATHE_MS = 250
  const MAX_WAIT_MS = 2000

  let timer: number | null = null

  /** 取消等待中的朗讀；由 stopSpeak() 的掛鉤呼叫 */
  const clear = () => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  // 登記取消掛鉤，呼吸結束真正 speak 時移除
  stopSpeakHooks.push(clear)

  const released = () => {
    stopSpeakHooks = stopSpeakHooks.filter((h) => h !== clear)
  }

  const waitStart = Date.now()
  const attempt = () => {
    timer = null
    if (synth.speaking || synth.pending) {
      // 引擎還在忙，輪詢等待（最長 MAX_WAIT_MS，避免永遠不唸）
      if (Date.now() - waitStart < MAX_WAIT_MS) {
        timer = window.setTimeout(attempt, IDLE_POLL_MS)
      }
      return
    }
    // 引擎空閒了，再呼吸一下讓釋放徹底完成，才真正開始唸
    timer = window.setTimeout(() => {
      timer = null
      released()
      synth.speak(utterance)
    }, IDLE_BREATHE_MS)
  }
  attempt()
}

/** 用瀏覽器內建語音合成朗讀（英文） */
export function speak(text: string): boolean {
  const synth = window.speechSynthesis
  if (!synth) return false
  stopSpeak()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'en-US'
  utterance.rate = 0.9
  utterance.pitch = 1
  beginWhenIdle(synth, utterance)
  return true
}

export function stopSpeak(): void {
  const hooks = stopSpeakHooks
  stopSpeakHooks = []
  for (const hook of hooks) hook()
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
