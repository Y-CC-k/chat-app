// 數學助教：出題（基礎／進階／挑戰）、批改答題、逐題引導提示
// 設計原則：小考題目由伺服器產生（沒有 LLM 也能玩），
// 學生問數學題時用「提示引導」而不是直接給答案，適合國小生。

import type { FaqEntry } from '../shared/protocol'

// ── 小考狀態（每間房間一題；逾時自動公布答案） ──────────────────

export interface Quiz {
  question: string
  answer: number
  /** 1 基礎、2 進階、3 挑戰 */
  level: 1 | 2 | 3
  asker: string
  askerId: string
  startedAt: number
  wrongCount: number
}

/** 每題最長作答時間 */
export const QUIZ_TIME_LIMIT_MS = 3 * 60 * 1000

/** 房間 id → 目前進行中的小考 */
const quizzes = new Map<string, Quiz>()

export function activeQuiz(roomId: string): Quiz | null {
  return quizzes.get(roomId) ?? null
}

export function startQuiz(roomId: string, level: 1 | 2 | 3, asker: string, askerId: string): Quiz {
  const made = makeQuestion(level)
  const quiz: Quiz = { ...made, level, asker, askerId, startedAt: Date.now(), wrongCount: 0 }
  quizzes.set(roomId, quiz)
  return quiz
}

export function stopQuiz(roomId: string): Quiz | null {
  const quiz = quizzes.get(roomId) ?? null
  quizzes.delete(roomId)
  return quiz
}

/** 小考逾時檢查：超過時限回傳該題並自動結束（由呼叫端公布答案） */
export function expireQuizIfNeeded(roomId: string): Quiz | null {
  const quiz = quizzes.get(roomId)
  if (!quiz) return null
  if (Date.now() - quiz.startedAt > QUIZ_TIME_LIMIT_MS) {
    quizzes.delete(roomId)
    return quiz // 逾時：呼叫端公布答案
  }
  return null
}

// ── 出題器 ────────────────────────────────────────────────────────

const rint = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1))

/** 依難度產生題目（基礎＝兩位數加減、進階＝三位數加減或兩位×一位、挑戰＝兩步驟運算） */
function makeQuestion(level: 1 | 2 | 3): { question: string; answer: number } {
  if (level === 1) {
    // 兩位數加或減（結果不為負）
    const a = rint(20, 99)
    const b = rint(10, a)
    return Math.random() < 0.5
      ? { question: `${a} + ${b} = ？`, answer: a + b }
      : { question: `${a} − ${b} = ？`, answer: a - b }
  }
  if (level === 2) {
    if (Math.random() < 0.5) {
      // 三位數加減
      const a = rint(150, 999)
      const b = rint(100, a)
      return Math.random() < 0.5
        ? { question: `${a} + ${b} = ？`, answer: a + b }
        : { question: `${a} − ${b} = ？`, answer: a - b }
    }
    // 乘法表範圍：兩位 × 一位
    const a = rint(12, 29)
    const b = rint(3, 9)
    return { question: `${a} × ${b} = ？`, answer: a * b }
  }
  // 挑戰：兩步驟 a × b ± c
  const a = rint(11, 19)
  const b = rint(4, 9)
  const c = rint(10, 99)
  return Math.random() < 0.5
    ? { question: `${a} × ${b} + ${c} = ？`, answer: a * b + c }
    : { question: `${a} × ${b} − ${c} = ？`, answer: a * b - c }
}

export function quizLevelName(level: 1 | 2 | 3): string {
  return level === 1 ? '基礎' : level === 2 ? '進階' : '挑戰'
}

/** 開始小考的訊息（含題目與作答說明） */
export function quizQuestionReply(quiz: Quiz): string {
  return [
    `📝 ${quizLevelName(quiz.level)}小考開始！題目：`,
    `${quiz.question}`,
    '直接輸入你的答案（只要數字）就好喔！時間限 3 分鐘 ⏰',
  ].join('\n')
}

// ── 批改 ──────────────────────────────────────────────────────────

/** 從訊息中取出純數字答案（例如「24」「答案是24」→ 24）；不是數字回 null */
export function extractAnswer(text: string): number | null {
  const cleaned = text.replace(/[，,、\s]/g, '')
  // 整句就是數字 → match[0]；句子裡含數字 → 取第一組
  const raw = /^-?\d+(?:\.\d+)?$/.exec(cleaned)?.[0] ?? /-?\d+(?:\.\d+)?/.exec(cleaned)?.[0]
  if (raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function firstAttemptEncouragement(): string {
  return Math.random() < 0.5
    ? '差一點點了！再想想看 🤔'
    : '很近了喔！再檢查一次計算步驟 💪'
}

/** 答錯時依錯了幾次給不同程度的提示（引導，不直接給答案） */
export function wrongAnswerHint(quiz: Quiz): string {
  if (quiz.wrongCount === 1) {
    return quiz.level === 1
      ? '提示：先算個位，再算十位，進位／借位要記得喔 🙂'
      : quiz.level === 2
        ? '提示：減法可以先檢查借位；乘法可以拆成「10 × b + 剩下 × b」來算 👀'
        : '提示：先算乘法那一步，再加減後面的數字 🤓'
  }
  if (quiz.wrongCount === 2) {
    return '提示：把題目一步步抄下來慢慢算，算完每一步先檢查一次！🧐'
  }
  return `答案揭曉：${quiz.question.replace(' = ？', '')} = ${quiz.answer}！換下一題：輸入 /數學小考 再考一次 🎯`
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

export function correctReply(): string {
  const cheers = ['🎉 太棒了！答對了！', '👏 全對！你好厲害！', '🌟 答對了！數學小天才！', '💯 滿分作答，繼續保持！']
  return pick(cheers)
}

export function timeUpReply(quiz: Quiz): string {
  return `⏰ 時間到！${quiz.question.replace(' = ？', '')} = ${quiz.answer}。不怕，下次一定行！輸入 /數學小考 再來一次 🎯`
}

// ── 逐題引導（非小考的一般數學問題） ──────────────────────────────

export const MATH_SYSTEM_PROMPT = [
  '你是臺灣國民小學聊天室「數學教室」裡的「數學助教」，使用者是 6～12 歲的小學生（一到六年級）。',
  '規則：',
  '- 一律使用台灣繁體中文，語氣親切、有耐心、正向鼓勵；遣詞用字適合小學生閱讀。',
  '- **核心原則：引導代替直接給答案。** 學生問題目時，先問清楚他懂到哪裡，再給一步一步的小提示（例如：先想想個位數、先畫圖、先列出算式），不要直接把答案寫出來。',
  '- 如果學生很確定想要答案或是重複問第三次以上，可以先給「類似但更簡單的例題」示範算法，讓他自己套用到原題。',
  '- 學生答對或答對小考題時，要大大稱讚並鼓勵他挑戰更高難度（/數學小考 挑戰）。',
  '- 嚴禁不雅、粗俗、暴力、歧視字句；不批評學生笨，只針對做法給建議。',
  '- 回答格式：用「•」或「-」條列、每點換行；總字數不超過 100 字。',
  '- 難度判定：低年級用生活中的例子（蘋果、積木），高年級可用分數、小數、面積。',
  '- 與數學無關的問題：溫和地引導他回大廳問「小幫手」，或到英文教室找英文助教。',
].join('\n')

export function mathIntro(): string {
  return [
    '我是數學助教 ➗ 歡迎來到數學教室！',
    '1. 直接問我數學題：我會用提示一步一步引導你想出答案（不直接給答案喔）',
    '2. 輸入 /數學小考 隨機出題，考完我幫你批改（/數學小考 挑戰 更刺激）',
    '3. 輸入 /停止小考 結束進行中的小考',
  ].join('\n')
}

/** 沒有 LLM 時的引導式罐頭回覆（視是否為問句選用） */
const MATH_FALLBACK_QUESTIONS = [
  '先試著把題目畫成圖或列出算式，再一步步算算看！看不出來的話，把你已經知道的部分告訴我 🙂',
  '可以把題目分成兩小塊：先算第一小塊，再算第二小塊。算到哪一步卡住了？告訴我！💪',
  '先讀懂題目在問什麼，寫下「已經知道的」和「要找的」，通常就會想出第一步了 ✏️',
]

const MATH_FALLBACK_GREETINGS = [
  '你好呀！我是數學助教 🤓 直接問我數學題，或輸入 /數學小考 玩出題遊戲！',
  '嗨～歡迎來數學教室！從 /數學小考 開始最熱鬧喔 🎯',
]

export function mathFallbackReply(question: boolean): string {
  return question ? pick(MATH_FALLBACK_QUESTIONS) : pick(MATH_FALLBACK_GREETINGS)
}

/** 是否有人在房內提到數學助教 */
export function isMathTutorMention(text: string): boolean {
  return text.includes('數學助教')
}

/** 小考進行中，判斷訊息是否為作答（純數字） */
export function isQuizAnswer(text: string, faqs: FaqEntry[]): boolean {
  if (!text) return false
  if (text.trim().startsWith('/')) return false
  // 命中自訂 FAQ 的句子不是答案
  if (faqs.some((faq) => text.toLowerCase().includes(faq.keyword.toLowerCase()))) return false
  return extractAnswer(text) !== null
}

/** 解析 /數學小考 的難度參數；預設 1 */
export function parseQuizLevel(arg: string): 1 | 2 | 3 | null {
  const normal = arg.trim().toLowerCase().replace(/級|難度/g, '')
  if (!normal) return 1
  if (normal.startsWith('基礎') || normal === '1' || normal.startsWith('easy')) return 1
  if (normal.startsWith('進階') || normal === '2' || normal.startsWith('mid')) return 2
  if (normal.startsWith('挑戰') || normal === '3' || normal.startsWith('hard')) return 3
  return 1
}
