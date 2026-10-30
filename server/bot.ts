// 機器人「小幫手」：指令解析、FAQ 比對、罐頭回覆
import type { FaqEntry } from '../shared/protocol'

/** 隨機抽一個元素 */
export function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

const BOT_FALLBACK_REPLIES = [
  '這個問題我還不太會回答 😥 可以請同學幫幫忙，或用「/教 關鍵字=答案」教我！',
  '嗯…我還在學習中 🤔 用「/教 關鍵字=答案」教我，下次我就會了！',
  '這題太難了，我看還是由真人來回答比較好 😆',
]

const BOT_JOKES = [
  '為什麼程式設計師分不清萬聖節和聖誕節？因為 Oct 31 == Dec 25 🎃🎄',
  '有兩種人：一種是能從零開始數數的，另一種是……你懂得。',
  '小明問老師：「老師，我家有 15 台電腦，但我爸都只用小筆電，為什麼？」老師：「因為筆電便攜，但你爸偏遠。」',
  '昨天我明明沒睡著，今天卻有人叫我「睡美人」，原來是來自瀏覽器的頁面休眠。',
  '我最好的朋友是「自動存檔」——在我們最無助的時刻救了我。',
]

const BOT_GREETINGS = [
  '你好呀！我是小幫手 🤖 有什麼問題可以隨時問我，輸入「/說明」看看我能做什麼！',
  '嗨～我是小幫手 🤖 很高興為大家服務！',
  '你好你好！我是小幫手 🤖 輸入「/說明」看看我能做什麼！',
]

/** 是否直接點名機器人（包含在中間也算） */
export function isBotMention(text: string): boolean {
  return text.includes('小幫手')
}

// ── 抱怨／負面語句：統一導引洽學校處理 ──────────────────────────

const COMPLAINT_WORDS = [
  '抱怨', '投訴', '告狀', '不滿', '抗議', '檢舉', '討厭學校', '不想上學',
  '不想去學校', '不想上課', '要我告', '告你', '告學校', '告老師', '罵學校', '罵老師',
  '好討厭', '好煩', '很煩', '好生氣', '很生氣', '好難過', '很難過', '太不公平', '不公平',
  '被欺負', '欺負我', '有人罵我', '威脅我',
]

/** 是否為抱怨語句（攻擊性／髒話由敏感詞遮蔽另一層處理；這裡抓情緒申訴類） */
export function isComplaint(text: string): boolean {
  return COMPLAINT_WORDS.some((word) => text.includes(word))
}

export function complaintReply(): string {
  return [
    '🤝 聽起來你可能不太開心，辛苦了！',
    '把事情完整告訴學校的老師或主任，大家都會幫忙你喔。',
    '📞 學校電話：(04)26562684',
  ].join('\n')
}

/** 是否為問題句（以問號結尾或包含問號） */
export function isQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text) || text.includes('？')
}

/** 比對自訂 FAQ：關鍵字出現在訊息中即命中（後教優先） */
export function matchFaq(text: string, faqs: FaqEntry[]): FaqEntry | null {
  const lower = text.toLowerCase()
  let hit: FaqEntry | null = null
  for (const faq of faqs) {
    if (lower.includes(faq.keyword.toLowerCase())) hit = faq
  }
  return hit
}

export function fallbackReply(): string {
  return pick(BOT_FALLBACK_REPLIES)
}

// ── 英文助教：中文 ↔ 英文翻譯 ────────────────────────────────────

const TUTOR_TRIGGER = '英文助教'

export function isTutorMention(text: string): boolean {
  return text.includes(TUTOR_TRIGGER)
}

/** 判斷是否以中文為主（決定翻譯方向） */
export function isMostlyChinese(text: string): boolean {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const letters = (text.match(/[A-Za-z]/g) ?? []).length
  return cjk >= letters && cjk > 0
}

/** 判斷是否以英文為主（決定是否需要朗讀） */
export function isMostlyEnglish(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length
  return letters >= (text.match(/[\u4e00-\u9fff]/g) ?? []).length && letters > 0
}

export function tutorIntro(): string {
  return [
    '我是英文助教 📣 歡迎來到英文教室！',
    '1. 直接打想說的中文：我會幫你翻成英文，並用標準美國口音唸出來',
    '2. 打英文句子：我會翻回中文，幫你確認意思',
    '每句訊息（包括你自己的）都會朗讀——這裡是全聊天室唯一有朗讀的房間喔！',
  ].join('\n')
}

const TRANSLATE_TIMEOUT_MS = 8000
const MAX_TRANSLATE_LENGTH = 400

/**
 * 透過 Google 翻譯的公共端點翻譯（不需要 API 金鑰）。
 * 中文為主 → 翻成英文；英文為主 → 翻回中文。
 */
export async function translateText(text: string): Promise<string> {
  const source = isMostlyChinese(text) ? 'zh-TW' : 'en'
  const target = isMostlyChinese(text) ? 'en' : 'zh-TW'
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text.slice(0, MAX_TRANSLATE_LENGTH))}`
  const response = await fetch(url, { signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`translate http ${response.status}`)
  const data = (await response.json()) as unknown
  const segments = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : []
  const joined = segments.map((segment) => (Array.isArray(segment) ? String(segment[0] ?? '') : '')).join('')
  if (!joined) throw new Error('translate empty response')
  return joined
}

export function greetingReply(): string {
  return pick(BOT_GREETINGS)
}

export function jokeReply(): string {
  return pick(BOT_JOKES)
}

// ── 斜線指令 ──────────────────────────────────────────────────────

export interface Command {
  name: string
  args: string
}

/** 解析開頭為「/」的指令；不是指令回傳 null */
export function parseCommand(raw: string): Command | null {
  const match = /^\/([^\s=]{1,12})(?:\s+([\s\S]+))?$/.exec(raw.trim())
  if (!match) return null
  return { name: match[1], args: (match[2] ?? '').trim() }
}

const HELP_TEXT = [
  '🤖 小幫手指令一覽：',
  '訊息開頭輸入「@ 」再加上問題 → 直接問機器人（不用開關）',
  '/時間 — 告訴你現在幾點',
  '/成員 — 列出房間內的成員',
  '/骰子 — 擲骰子（1-100）',
  '/笑話 — 來一個笑話',
  '/教 關鍵字=回答 — 教我自動回答',
  '/忘 關鍵字 — 刪除該關鍵字',
  '/清單 — 看目前學會的自動回覆',
  '另外，訊息中提到「小幫手」我會直接回你！',
  '貼圖：表情符號 😊、貼圖 🎉、上傳圖片 📎，或直接貼上剪貼簿圖片。',
].join('\n')

/** 回覆指令；public = 是否廣播給整個房間（private = 只回給下指令的人） */
export function commandReply(
  cmd: Command,
  ctx: {
    userId: string
    nickname: string
    faqs: FaqEntry[]
  },
): { text: string; public: boolean } | null {
  switch (cmd.name) {
    case '說明':
    case 'help':
    case '指令':
      return { text: HELP_TEXT, public: false }

    case '時間': {
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(now.getMinutes()).padStart(2, '0')
      const date = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`
      return { text: `現在時間：${date} ${hh}:${mm}️`, public: true }
    }

    case '骰':
    case '骰子': {
      const value = 1 + Math.floor(Math.random() * 100)
      return { text: `🎲 ${ctx.nickname} 擲出了 ${value} 點！`, public: true }
    }

    case '笑話':
      return { text: jokeReply(), public: true }

    // 「教」「忘」需要寫入伺服器資料，由 index.ts 直接處理

    case '清單':
    case 'faq':
    case 'FAQ': {
      if (ctx.faqs.length === 0) {
        return { text: '目前還沒有任何自訂回覆，快用「/教 關鍵字=回答」教我吧！', public: false }
      }
      const lines = ctx.faqs.map((faq, index) => `${index + 1}. 「${faq.keyword}」→ ${faq.answer}`)
      return { text: `📚 目前學會 ${ctx.faqs.length} 條自動回覆：\n${lines.join('\n')}`, public: false }
    }

    default:
      return { text: `沒有「/${cmd.name}」這個指令，輸入「/說明」看看我能做什麼。`, public: false }
  }
}
