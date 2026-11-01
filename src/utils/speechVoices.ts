// 英文教室朗讀：瀏覽器內建 Web Speech API + 語音清單（男女聲可選）
// 取自 chinese-translator；與 speech.ts（訊息朗讀）分開，不互相干擾

/** 目前朗讀實例：Chrome 在 utterance 被回收後不會觸發事件，必須保住參考 */
let activeUtterance: SpeechSynthesisUtterance | null = null

/** 列出指定語系的語音（母語區優先） */
function listVoicesByPrefix(prefix: 'en' | 'zh'): SpeechSynthesisVoice[] {
  const voices = window.speechSynthesis?.getVoices() ?? []
  const matched = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix))
  const prefer = prefix === 'en' ? /en[-_]us/i : /zh[-_]tw/i
  const score = (v: SpeechSynthesisVoice) => (prefer.test(v.lang) ? 0 : 1)
  return [...matched].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
}

export interface VoiceSet {
  en: SpeechSynthesisVoice[]
  zh: SpeechSynthesisVoice[]
  all: SpeechSynthesisVoice[]
}

/** 取得目前全部語音清單 */
export function listVoiceSet(): VoiceSet {
  const voices = window.speechSynthesis?.getVoices() ?? []
  return {
    en: listVoicesByPrefix('en'),
    zh: listVoicesByPrefix('zh'),
    all: [...voices].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** 訂閱語音清單（語音清單是瀏覽器非同步載入的）；回傳取消訂閱函式 */
export function subscribeVoices(callback: (set: VoiceSet) => void): () => void {
  const synth = window.speechSynthesis
  if (!synth) return () => {}
  const fire = () => callback(listVoiceSet())
  fire()
  synth.addEventListener('voiceschanged', fire)
  return () => synth.removeEventListener('voiceschanged', fire)
}

/** 依微軟語音命名慣例推測性別，僅用於介面標示 👩/👨 */
const FEMALE_HINTS = [
  'aria', 'jenny', 'zira', 'michelle', 'ana', 'emma', 'sara', 'yating', 'hanhan',
  'huihui', 'yaoyao', 'meijia', 'xiaoxiao', 'xiaoyi', 'hazel', 'kate', 'susan',
  'amber', 'ashley', 'cora', 'elizabeth', 'jane', 'monica', 'sonia', 'ava',
  'nancy', 'heidi', 'jessica', 'joanna', 'kendall', 'kristy', 'libby', 'lola',
  'maxine', 'yan', 'yundi', 'female',
]
const MALE_HINTS = [
  'guy', 'david', 'eric', 'christopher', 'brian', 'andrew', 'zhiwei', 'kangkang',
  'danny', 'george', 'yunye', 'yunxi', 'yunyang', 'james', 'john', 'kevin',
  'mark', 'ryan', 'steffan', 'thomas', 'tony', 'william', 'alfred', 'harry',
  'lewis', 'neil', 'sean', 'male',
]

export type VoiceGender = 'female' | 'male' | 'unknown'

export function voiceGender(v: SpeechSynthesisVoice): VoiceGender {
  const name = v.name.toLowerCase()
  if (FEMALE_HINTS.some((h) => name.includes(h))) return 'female'
  if (MALE_HINTS.some((h) => name.includes(h))) return 'male'
  return 'unknown'
}

/** 性別圖示，方便一眼挑選男女聲 */
export function voiceGenderIcon(v: SpeechSynthesisVoice): string {
  const g = voiceGender(v)
  return g === 'female' ? '👩 ' : g === 'male' ? '👨 ' : '🎧 '
}

/** 精簡語音顯示名稱：去掉「Microsoft」前綴與「- 語言(...)」後綴 */
export function voiceDisplayName(v: SpeechSynthesisVoice): string {
  return v.name
    .replace(/^Microsoft\s+/i, '')
    .split(/\s+-\s+/)[0]
    .trim()
}

export interface SpeakOptions {
  /** 文字語言：'en-US'（英文）或 'zh-TW'（中文），預設依此挑語音 */
  lang?: 'en-US' | 'zh-TW'
  /** 語速，預設 1 */
  rate?: number
  /** 指定語音；未指定時自動挑選該語言的預設語音 */
  voice?: SpeechSynthesisVoice | null
  /** 朗讀自然結束、被取消或出錯時都會呼叫（用於把按鈕狀態復原） */
  onEnd?: () => void
}

function pickDefaultVoice(lang: 'en-US' | 'zh-TW'): SpeechSynthesisVoice | undefined {
  const voices = listVoicesByPrefix(lang.startsWith('en') ? 'en' : 'zh')
  const exact = voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase())
  return exact ?? voices[0]
}

/** 待播的朗讀 timer：取消時要一起清掉，避免舊的朗讀在取消後又突然開始 */
let pendingSpeakTimer: number | null = null

export function speakText(text: string, options: SpeakOptions = {}): void {
  const synth = window.speechSynthesis
  if (!synth) throw new Error('此瀏覽器不支援語音朗讀')
  if (!text.trim()) return

  stopSpeaking()

  const lang = options.lang ?? 'en-US'
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang
  utterance.rate = options.rate ?? 1
  utterance.voice = options.voice ?? pickDefaultVoice(lang) ?? null

  if (options.onEnd) {
    const onEnd = options.onEnd
    // 只接受「目前這一次」朗讀的結束事件，避免舊的 cancelled 事件蓋掉新的朗讀狀態
    utterance.onend = () => {
      if (activeUtterance === utterance) {
        activeUtterance = null
        onEnd()
      }
    }
    utterance.onerror = () => {
      if (activeUtterance === utterance) {
        activeUtterance = null
        onEnd()
      }
    }
  }

  // Chrome 的已知問題：cancel() 後立刻 speak() 會把開頭幾個字吃掉（引擎未釋放完），
  // 延遲一小段時間再開始唸，第一個字才會完整。
  pendingSpeakTimer = window.setTimeout(() => {
    pendingSpeakTimer = null
    activeUtterance = utterance
    synth.speak(utterance)
  }, 250)
}

export function stopSpeaking(): void {
  if (pendingSpeakTimer !== null) {
    window.clearTimeout(pendingSpeakTimer)
    pendingSpeakTimer = null
  }
  activeUtterance = null
  window.speechSynthesis?.cancel()
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}
