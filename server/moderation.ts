// 敏感詞過濾：學生聊天室的安全防護網。
// 比對到的詞會以同長度的全形星號遮蔽，並可透過 CHAT_BLOCKED_WORDS（逗號分隔）額外追加。

const DEFAULT_BLOCKED_WORDS: string[] = [
  // ── 英文常見不雅詞與歧視詞 ──
  'fuck', 'fuk', 'fck', 'motherfucker', 'shit', 'bitch', 'bastard', 'asshole',
  'cunt', 'dick', 'nigger', 'nigga', 'faggot', 'whore', 'slut', 'rape',
  // ── 中文常見不雅詞與霸凌語 ──
  '幹你娘', '幹你媽', '操你媽', '操你娘', '他媽的', '机掰', '雞掰', '機掰',
  '賤人', '臭婊', '婊子', '廢物仔', '去死', '白痴', '智障', '腦殘', '雞巴',
]

/** 讀取敏感詞清單（預設清單 + CHAT_BLOCKED_WORDS 追加） */
export function loadBlockedWords(): string[] {
  const extra = (process.env.CHAT_BLOCKED_WORDS ?? '')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
  // 小寫統一（拉丁詞）；中文不受大小寫影響
  return [...new Set([...DEFAULT_BLOCKED_WORDS.map((word) => word.toLowerCase()), ...extra])]
}

/** 把字串中比對到的敏感詞換成同長度的全形星號 */
export function maskSensitiveWords(text: string, blockedWords: string[]): { text: string; masked: number } {
  let masked = 0
  let result = text
  for (const word of blockedWords) {
    if (!word || !result.toLowerCase().includes(word)) continue
    const stars = '＊'.repeat(Math.min(word.length, 6))
    // 大小寫不敏感全是換（拉丁詞）；用 split 保全中文邊界
    const pattern = new RegExp(`${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi')
    result = result.replace(pattern, (match) => {
      masked += 1
      void match
      return stars
    })
  }
  return { text: result, masked }
}
