// LLM 智慧答詢：使用 OpenAI 相容的 chat/completions 端點。
// 支援 OpenAI、LM Studio、Ollama（開啟 OpenAI 相容模式）等任何相容服務。
// 未設定（或缺設定值）時回傳 null，上層改用內建罐頭回覆。

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 從環境變數讀取設定；三個都齊才視為已啟用 */
export function loadLlmConfig(): LlmConfig | null {
  const baseUrl = (process.env.CHAT_LLM_BASE_URL ?? '').trim()
  const model = (process.env.CHAT_LLM_MODEL ?? '').trim()
  const apiKey = (process.env.CHAT_LLM_API_KEY ?? '').trim() || 'ollama'
  if (!baseUrl || !model) return null
  return {
    // 去掉結尾斜線
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey,
  }
}

export const HELPER_SYSTEM_PROMPT = [
  '你是線上聊天室裡的助理「小幫手」，出現在教室學習情境中，使用者是學生。',
  '規則：',
  '- 一律使用台灣繁體中文回覆，語氣親切活潑',
  '- 回覆簡短有幫忙（最多 3 句），不需要自我介紹或重複問題',
  '- 看到歷史對話要延續脈絡；不確定時誠實說明並鼓勵同學互相幫忙',
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
