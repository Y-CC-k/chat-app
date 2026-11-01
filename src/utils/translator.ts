// 英文教室翻譯引擎（取自 chinese-translator，免金鑰、瀏覽器直接呼叫）
export type Direction = 'zh2en' | 'en2zh'

export interface TranslateResult {
  text: string
  provider: string
}

const LANGS: Record<Direction, { from: string; to: string }> = {
  zh2en: { from: 'zh-TW', to: 'en' },
  en2zh: { from: 'en', to: 'zh-TW' },
}

/** 主要引擎：Google translate gtx 端點（免金鑰、支援 CORS） */
async function translateWithGoogle(
  text: string,
  from: string,
  to: string,
): Promise<TranslateResult> {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Google 翻譯失敗（HTTP ${res.status}）`)

  // 回傳格式：[[["譯文","原文",...],[...]], ...]
  const data: unknown = await res.json()
  const segments = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : []

  const translated = segments
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
    .join('')

  if (!translated) throw new Error('Google 翻譯回應格式異常')
  return { text: translated, provider: 'Google 翻譯' }
}

/** 備用引擎：MyMemory（免金鑰、支援 CORS，單次建議 500 字內） */
async function translateWithMyMemory(
  text: string,
  from: string,
  to: string,
): Promise<TranslateResult> {
  const url =
    'https://api.mymemory.translated.net/get' +
    `?q=${encodeURIComponent(text)}&langpair=${from}|${to}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`MyMemory 翻譯失敗（HTTP ${res.status}）`)

  const data: { responseData?: { translatedText?: string } } = await res.json()
  const translated = data.responseData?.translatedText

  if (!translated) throw new Error('MyMemory 沒有回傳譯文')
  return { text: translated, provider: 'MyMemory' }
}

/** 翻譯：先試 Google，失敗時自動改用 MyMemory */
export async function translate(text: string, dir: Direction): Promise<TranslateResult> {
  const trimmed = text.trim()
  if (!trimmed) return { text: '', provider: '' }

  const { from, to } = LANGS[dir]

  try {
    return await translateWithGoogle(trimmed, from, to)
  } catch (googleError) {
    try {
      return await translateWithMyMemory(trimmed, from, to)
    } catch {
      throw googleError instanceof Error ? googleError : new Error('翻譯失敗，請檢查網路連線')
    }
  }
}
