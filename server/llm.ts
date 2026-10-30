// LLM 智慧答詢：使用 OpenAI 相容的 chat/completions 端點。
// 支援 OpenAI、LM Studio、Ollama（開啟 OpenAI 相容模式）等任何相容服務。
// 未設定（或缺設定值）時回傳 null，上層改用內建罐頭回覆。

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 額外合併進請求 body 的參數（例如 Gemini 的 reasoning_effort） */
  extra?: Record<string, unknown>
}

interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 從環境變數讀取一組設定；齊全（baseUrl+model）才回傳 */
function readRoute(prefix: string): LlmConfig | null {
  const baseUrl = (process.env[`${prefix}_BASE_URL`] ?? '').trim()
  const model = (process.env[`${prefix}_MODEL`] ?? '').trim()
  const apiKey = (process.env[`${prefix}_API_KEY`] ?? '').trim() || 'ollama'
  if (!baseUrl || !model) return null
  // CHAT_LLM2_EXTRA 之類：JSON 字串，會整包合併進 chat/completions 的 body
  let extra: Record<string, unknown> | undefined
  const rawExtra = (process.env[`${prefix}_EXTRA`] ?? '').trim()
  if (rawExtra) {
    try {
      extra = JSON.parse(rawExtra) as Record<string, unknown>
    } catch {
      console.error(`[chat] ${prefix}_EXTRA 不是合法 JSON，已忽略`)
    }
  }
  return {
    // 去掉結尾斜線
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey,
    extra,
  }
}

/**
 * 從環境變數讀取 LLM 路由鏈：
 *   CHAT_LLM_*        （主路由）
 *   CHAT_LLM2_*       （備援 1）
 *   CHAT_LLM3_*、CHAT_LLM4_*（依此類推）
 * 前一個 provider 限流／失敗時自動改試下一個。
 */
export function loadLlmConfig(): LlmConfig[] {
  const chain: LlmConfig[] = []
  const prefixes = ['CHAT_LLM', 'CHAT_LLM2', 'CHAT_LLM3', 'CHAT_LLM4']
  for (const prefix of prefixes) {
    const route = readRoute(prefix)
    if (route) chain.push(route)
  }
  return chain
}

export const HELPER_SYSTEM_PROMPT = [
  '你是臺灣國民小學線上聊天室裡的助理「小幫手」，使用者是 6～12 歲的小學生。',
  '規則：',
  '- 一律使用台灣繁體中文，語氣親切、溫和、正向鼓勵，遣詞用字必須適合小學生閱讀',
  '- 嚴禁出現不雅、粗俗、暴力、歧視、恐嚇或任何負面攻擊性字句；也不要談論目前的負面新聞',
  '- 學校活動／行事曆類問題：若系統有附上「行事曆／公告／教育局／學校網站」查得的資料，就依那份**真實資料**回答（含日期）；資料裡沒有的內容不可編造，改引導看學校網站 https://klnes.tc.edu.tw 的公告或行事曆，或洽學校 (04)26562684',
  '- 非學校問題（一般知識、作業、生活常識等）：可依自身知識與系統附上的網路搜尋結果回答；若搜尋結果有網址，請附上參考連結',
  '- **回答格式**：重點請用「•」或「-」條列、每點換行，讓同學好讀；非學校問題若查到多筆資料也請條列',
  '- **長度原則**：回答總字數以不超過 100 字為原則；若資料很多，只列出最重要的 3～5 項，其餘引導到學校網站 https://klnes.tc.edu.tw',
  '- 回覆不需要自我介紹或重複問題；不確定時誠實說明並鼓勵同學互相幫忙',
  '- 如果使用者抱怨學校、老師、同學，或表達難過、生氣、委屈：先溫暖接住他的情緒，再建議他把事情告訴學校的老師或主任，並附上「學校電話：(04)26562684」',
].join('\n')

const LLM_TIMEOUT_MS = 25_000

/** 呼叫 chat/completions；失敗回傳 null（上層退回罐頭回覆） */
export async function llmChat(
  config: LlmConfig,
  messages: LlmMessage[],
  maxTokens = 500,
): Promise<string | null> {
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
        ...config.extra,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content?.trim()
    return content || null
  } catch {
    return null
  }
}

/**
 * 多路由輪替：依序嘗試設定中的每個 provider，一家失敗（限流／逾時／空回覆）就換下一家；
 * 全部失敗才回 null（上層退回罐頭回覆）。
 */
export async function llmChatChain(
  chain: LlmConfig[],
  messages: LlmMessage[],
  maxTokens = 500,
): Promise<string | null> {
  const failures: string[] = []
  for (const config of chain) {
    const reply = await llmChat(config, messages, maxTokens)
    if (reply !== null) return reply
    failures.push(config.model)
  }
  if (chain.length > 1) console.error('[chat] 全部 LLM 路由失敗:', failures.join(' → '))
  return null
}
