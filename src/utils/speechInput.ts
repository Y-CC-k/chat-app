// 英文教室語音輸入：瀏覽器內建 Web Speech API（Chrome/Edge 支援、免金鑰）
// 取自 chinese-translator

interface SpeechRecognitionAlternativeLike {
  transcript: string
}
interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number
  [index: number]: SpeechRecognitionAlternativeLike
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [index: number]: SpeechRecognitionResultLike }
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

export function isSpeechInputSupported(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as Record<string, unknown>
  return 'SpeechRecognition' in w || 'webkitSpeechRecognition' in w
}

function mapError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '麥克風權限被拒絕，請允許網站使用麥克風'
    case 'no-speech':
      return '沒有偵測到說話內容，請再試一次'
    case 'audio-capture':
      return '找不到可用麥克風'
    case 'network':
      return '語音服務連線失敗，請檢查網路'
    default:
      return `語音輸入錯誤（${code}）`
  }
}

export interface ListenOptions {
  /** 認得的語言，如 'zh-TW' 或 'en-US' */
  lang: string
  /** 即時（未定稿）文字，用於邊說邊顯示 */
  onPartial?: (partialText: string) => void
  /** 這次收音結束後的最終文字 */
  onFinal?: (finalText: string) => void
  /** 收音結束（含出錯後結束） */
  onEnd?: () => void
  onError?: (message: string) => void
}

export interface ListenHandle {
  stop: () => void
}

/** 開始聽；一次收完一段就結束。回傳停止控制。 */
export function startListening(options: ListenOptions): ListenHandle {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) throw new Error('此瀏覽器不支援語音輸入')

  const rec = new Ctor()
  rec.lang = options.lang
  rec.continuous = false
  rec.interimResults = true

  let finalText = ''
  let errorSeen = false

  rec.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const transcript = result[0]?.transcript ?? ''
      if (result.isFinal) finalText += transcript
      else interim += transcript
    }
    const partial = (finalText + interim).trim()
    if (partial) options.onPartial?.(partial)
  }
  rec.onerror = (event) => {
    errorSeen = true
    options.onError?.(mapError(event.error))
  }
  rec.onend = () => {
    const final = finalText.trim()
    if (final) options.onFinal?.(final)
    if (!errorSeen) options.onEnd?.()
  }

  rec.start()
  return {
    stop: () => {
      try {
        rec.stop()
      } catch {
        /* 已停止時忽略 */
      }
    },
  }
}
