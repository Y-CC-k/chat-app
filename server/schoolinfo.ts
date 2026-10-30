/**
 * 學校事情查證管線：學校網站 → 教育局網站。
 * ① 學校網站：校務佈告欄最新公告（school.tc.edu.tw 公開頁，純 HTML 可直接抓）
 * ② 校務行事曆：公開 Google 日曆 ICS（見 calendar.ts）
 * ③ 教育局網站：www.tc.edu.tw 的搜尋是 JS 版搜不到，改用 Bing 站內限定搜尋（site:www.tc.edu.tw）best-effort
 * 查到的內容組成文字上下文交給 LLM；全部查不到就回 null，走原本「誠實導引洽學校」路徑。
 * 各來源快取 10～30 分鐘，抓取失敗不影響回覆主流程。
 */

import { isCalendarQuestion, schoolCalendarContext } from './calendar'

const SCHOOL_BOARD_URL = 'https://school.tc.edu.tw/open-message/064739'
const OPEN_DATA_API_URL = 'https://data.gov.tw/api/front/dataset/list'

const FETCH_TIMEOUT_MS = 9_000
const BOARD_CACHE_TTL_MS = 10 * 60 * 1000
const OPEN_DATA_CACHE_TTL_MS = 30 * 60 * 1000

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
 * 學校事情查證上下文：佈告欄＋（行事曆類問題）行事曆＋（政府資料開放平台）資料集搜尋。
 * 全部都查不到時回 null。
 */
export async function schoolWebContext(question: string): Promise<string | null> {
  const wantsSchool = isSchoolInfoQuestion(question)
  const wantsCalendar = isCalendarQuestion(question)
  if (!wantsSchool && !wantsCalendar) return null

  const parts: string[] = []

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
