/**
 * 學校事情查證管線：依優先順序
 *   ① 學校網站內頁（klnes.tc.edu.tw 選單頁面，優先）
 *   ② 臺中市 tc.edu.tw 槺榔國小介紹頁
 *   ③ 校務佈告欄最新公告（school.tc.edu.tw）
 *   ④ 校務行事曆（Google ICS）
 *   ⑤ 政府資料開放平台（data.gov.tw）
 *   ⑥ 網路搜尋（Bing，best-effort）
 * 查到的內容組成文字上下文交給 LLM；全部查不到就回 null，走原本「誠實導引洽學校」路徑。
 * 各來源快取 10～30 分鐘，抓取失敗不影響回覆主流程。
 */

import { isCalendarQuestion, schoolCalendarContext } from './calendar'

const SCHOOL_BOARD_URL = 'https://school.tc.edu.tw/open-message/064739'
const OPEN_DATA_API_URL = 'https://data.gov.tw/api/front/dataset/list'

const FETCH_TIMEOUT_MS = 9_000
const BOARD_CACHE_TTL_MS = 10 * 60 * 1000
const OPEN_DATA_CACHE_TTL_MS = 30 * 60 * 1000

const SCHOOL_HOME = 'https://klnes.tc.edu.tw'

/** 學校網站內頁（優先資料來源）：網址 + 標題 + 關鍵字（命中任一即納入候選） */
const SCHOOL_PAGES: Array<{ url: string; title: string; keywords: string[] }> = [
  { url: 'https://www.tc.edu.tw/page/d61c396e-63a3-4286-ac38-9874ac4092fe/school-content?id=460', title: '關於槺榔國小', keywords: ['學校', '介紹', '歷史', '校史', '校長', '願景', '校徽', '地址', '電話', '聯絡', '校園', '校園環境', '特色', '國際', '雙語', '校本'] },
  { url: `${SCHOOL_HOME}/p/426-1348-5.php`, title: '校長室', keywords: ['校長', '校長室', '校長的話', '領導', '校務', '願景'] },
  { url: `${SCHOOL_HOME}/p/426-1348-2.php`, title: '網站導覽', keywords: ['導覽', '網站', '選單', '連結', '各處室'] },
  { url: 'https://maggie26562684.blogspot.com/p/09_3.html', title: '課程計畫', keywords: ['課程', '課表', '課綱', '教學', '學習', '計畫', '課後', '才藝'] },
  { url: 'https://maggie26562684.blogspot.com/', title: '教務處', keywords: ['教務', '註冊', '成績', '考試', '課務', '課表', '教科書', '作業'] },
  { url: 'https://klnes-oosa.blogspot.com/', title: '學務處', keywords: ['學務', '學生活動', '社團', '運動會', '制服', '生活教育', '訓育', '衛生', '健康'] },
  { url: 'http://klnes-counseling.blogspot.com/', title: '輔導室', keywords: ['輔導', '諮商', '性平', '性別', '霸凌', '情緒', '人際', '諮商室'] },
  { url: 'https://school.tc.edu.tw/064739', title: '校務系統', keywords: ['校務', '系統', '公告', '榮譽榜', '成績'] },
]

const SCHOOL_PAGE_CACHE_TTL_MS = 30 * 60 * 1000
const schoolPageCache = new Map<string, CacheEntry<string | null>>()

interface BoardItem {
  title: string
  date: string
  url: string
}

interface SearchHit {
  title: string
  agency: string
  url: string
}

/** 是否在問「學校的事情」→ 啟動查證管線 */
export function isSchoolInfoQuestion(text: string): boolean {
  return /學校|校園|校慶|校務|上學|開學|放假|補假|作息|放學|下課|接送|制服|書包|午餐|社團|才藝|報名|招生|入學|新生|轉學|學費|註冊|課後|課照|親師|家長|座談|導師|老師|校長|主任|行事曆|活動|比賽|營隊|想到|要去|哪裡|電話|地址|幼兒園|小一|畢業|校外|參觀|參訪|運動會|寒假|暑假|春假|選修|才藝班|圖書|志工|槺榔|klnes/.test(
    text,
  )
}

interface CacheEntry<T> {
  at: number
  value: T
}

let boardCache: CacheEntry<BoardItem[]> | null = null
const openDataCache = new Map<string, CacheEntry<SearchHit[] | null>>()

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9',
      },
    })
    if (!(res.ok || (res.status >= 300 && res.status < 400 && res.headers.get('location')))) return null
    return await res.text()
  } catch {
    return null
  }
}

/** 抓學校內頁 HTML → 純文字（移除 script/style/標籤，快取 30 分鐘） */
async function fetchSchoolPageText(url: string): Promise<string | null> {
  const cached = schoolPageCache.get(url)
  if (cached && Date.now() - cached.at < SCHOOL_PAGE_CACHE_TTL_MS) return cached.value
  const html = await fetchText(url)
  if (html === null) {
    schoolPageCache.set(url, { at: Date.now(), value: null })
    return null
  }
  // 移除 script/style/nav/footer，避免導覽列雜訊
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
  const text = cleaned
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const sliced = text.slice(0, 1800)
  schoolPageCache.set(url, { at: Date.now(), value: sliced })
  return sliced
}

/** 網路搜尋（Bing，best-effort；快取 30 分鐘／組關鍵字） */
const webSearchCache = new Map<string, CacheEntry<SearchHit[] | null>>()
async function webSearch(question: string): Promise<string | null> {
  const key = question.trim()
  const cached = webSearchCache.get(key)
  if (cached && Date.now() - cached.at < OPEN_DATA_CACHE_TTL_MS) {
    if (!cached.value || cached.value.length === 0) return null
    return [
      '【網路搜尋結果（參考，來源：Bing）】',
      ...cached.value.slice(0, 5).map((h) => `- ${h.title}${h.agency ? `（${h.agency}）` : ''} ${h.url}`),
    ].join('\n')
  }
  try {
    const q = `${question} 槺榔國小`.slice(0, 200)
    const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-hant`)
    if (html === null) {
      webSearchCache.set(key, { at: Date.now(), value: null })
      return null
    }
    const hits: SearchHit[] = []
    const re = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      const url = m[1]
      if (!url.startsWith('http')) continue
      const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      if (!title) continue
      if (hits.some((h) => h.url === url)) continue
      // 嘗試抓 snippet（<p> 或 <div class="b_caption"> 內文）
      hits.push({ title, agency: '', url })
      if (hits.length >= 5) break
    }
    webSearchCache.set(key, { at: Date.now(), value: hits })
    if (hits.length === 0) return null
    return [
      '【網路搜尋結果（參考，來源：Bing）】',
      ...hits.map((h) => `- ${h.title} ${h.url}`),
    ].join('\n')
  } catch {
    return null
  }
}
function pickSchoolPages(question: string): Array<{ url: string; title: string }> {
  const scored = SCHOOL_PAGES.map((p) => {
    let score = 0
    for (const kw of p.keywords) {
      if (question.includes(kw)) score += 2
    }
    // 通用關鍵字保底：問到學校事情時至少拉「關於槺榔」
    if (score === 0 && /學校|校園|槺榔|klnes/i.test(question)) score = 1
    return { ...p, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const picked = scored.filter((p) => p.score > 0).slice(0, 2)
  if (picked.length === 0) picked.push(scored[0])
  // 去重
  const seen = new Set<string>()
  return picked.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)))
}

/** 學校網站內頁查證上下文（優先來源） */
async function schoolSiteContext(question: string): Promise<string | null> {
  const pages = pickSchoolPages(question)
  const blocks: string[] = []
  for (const p of pages) {
    const text = await fetchSchoolPageText(p.url)
    if (!text || text.length < 40) continue
    blocks.push(`【槺榔國小網站「${p.title}」頁面內容（來源：${p.url}）】\n${text}`)
  }
  if (blocks.length === 0) return null
  return blocks.join('\n\n')
}

/** 校務佈告欄最新公告（快取 10 分鐘） */
export async function schoolBoard(): Promise<BoardItem[]> {
  if (boardCache && Date.now() - boardCache.at < BOARD_CACHE_TTL_MS) return boardCache.value
  const html = await fetchText(SCHOOL_BOARD_URL)
  if (!html) return boardCache?.value ?? []
  const items: BoardItem[] = []
  const re = /<a[^>]+class="new-title"[^>]*href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>\s*<\/td>\s*<td[^>]*>([\d-]{10})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const title = m[2].replace(/\s+/g, ' ').trim()
    if (!title) continue
    items.push({ title, date: m[3], url: new URL(m[1], SCHOOL_BOARD_URL).toString() })
  }
  // 依日期新到舊
  items.sort((a, b) => b.date.localeCompare(a.date))
  if (items.length > 0) boardCache = { at: Date.now(), value: items }
  return items
}

/** 政府資料開放平台（data.gov.tw）資料集搜尋（快取 30 分鐘／組關鍵字；抓不到回 null，不代表沒有資料） */
async function openDataSearch(question: string): Promise<SearchHit[] | null> {
  const key = question.trim()
  const cached = openDataCache.get(key)
  if (cached && Date.now() - cached.at < OPEN_DATA_CACHE_TTL_MS) return cached.value
  try {
    const keyword = question.replace(/[？?！!，,。．.\s]+/g, ' ').trim().slice(0, 120)
    const res = await fetch(OPEN_DATA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      // 官網搜尋用的真實格式（fulltext 全文比對）
      body: JSON.stringify({
        bool: [{ fulltext: { value: keyword } }],
        filter: [],
        page_num: 1,
        page_limit: 8,
        tids: [],
        sort: '_score_desc',
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      openDataCache.set(key, { at: Date.now(), value: null })
      return null
    }
    const j = (await res.json()) as {
      payload?: {
        search_result?: Array<{ title?: string; agency_name?: string; nid?: number; content?: string }>
      }
    }
    const hits: SearchHit[] = (j.payload?.search_result ?? [])
      .filter((r) => r.title && r.nid)
      .map((r) => ({
        title: String(r.title).trim(),
        agency: String(r.agency_name ?? '').trim(),
        url: `https://data.gov.tw/dataset/${r.nid}`,
      }))
    openDataCache.set(key, { at: Date.now(), value: hits })
    return hits
  } catch {
    return null // 抓取失敗不快取，下次再試
  }
}

/**
 * 學校事情查證上下文：依優先順序：
 *   ① 學校網站內頁（klnes.tc.edu.tw 選單頁面，優先）
 *   ② 臺中市 tc.edu.tw 槺榔國小介紹頁
 *   ③ 校務佈告欄最新公告
 *   ④ 校務行事曆（行事曆類問題）
 *   ⑤ 政府資料開放平台
 *   ⑥ 網路搜尋（best-effort）
 * 全部都查不到時回 null。
 */
export async function schoolWebContext(question: string): Promise<string | null> {
  const wantsSchool = isSchoolInfoQuestion(question)
  const wantsCalendar = isCalendarQuestion(question)
  if (!wantsSchool && !wantsCalendar) return null

  const parts: string[] = []

  if (wantsSchool) {
    // ①② 學校網站內頁（優先）
    const site = await schoolSiteContext(question)
    if (site) parts.push(site)
  }

  if (wantsCalendar) {
    const cal = await schoolCalendarContext()
    if (cal) parts.push(cal)
  }

  if (wantsSchool) {
    const board = await schoolBoard()
    if (board.length > 0) {
      parts.push([
        '【槺榔國小校務佈告欄最新公告（來源：學校網站）】',
        ...board.slice(0, 12).map((b) => `- ${b.date} ${b.title}`),
        `※ 公告內文：https://klnes.tc.edu.tw（校務佈告欄）`,
      ].join('\n'))
    }
    const hits = await openDataSearch(question)
    if (hits) {
      parts.push(
        hits.length > 0
          ? [
              '【政府資料開放平台（data.gov.tw）搜尋結果】',
              ...hits.slice(0, 6).map((h) => `- ${h.title}（資料機關：${h.agency || '政府'}）${h.url}`),
            ].join('\n')
          : '【政府資料開放平台搜尋】沒有找到相關的資料集',
      )
    }
    // ⑥ 網路搜尋（best-effort）
    const web = await webSearch(question)
    if (web) parts.push(web)
  }

  if (parts.length === 0) return null
  return parts.join('\n\n')
}

/** 沒有 LLM 可用時的學校公告罐頭回答 */
export async function schoolBoardPlainAnswer(): Promise<string | null> {
  const items = await schoolBoard()
  if (items.length === 0) return null
  const lines = items
    .slice(0, 6)
    .map((b) => `- ${b.date} ${b.title}`)
  return `最新的學校公告：\n${lines.join('\n')}\n（公告詳情請上學校網站 klnes.tc.edu.tw，或打 (04)26562684 詢問）`
}
