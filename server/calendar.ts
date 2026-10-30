/**
 * 槺榔國小校務行事曆：抓公開 Google 日曆的 ICS feed，解析出近期活動。
 * 「活動／行事曆」類問題時把這份真實資料塞進 LLM 上下文，避免 AI 編造或一律說「去網站看」。
 * 抓取結果快取 10 分鐘，失敗時回上一次成功資料（沒有則 null → 走原本的誠實導引）。
 */

const CALENDAR_ICS_URL =
  'https://calendar.google.com/calendar/ical/c_f35d04a93a35b172216e7680d074bbf61634161ae72bfadc33115e2f7f4082cd%40group.calendar.google.com/public/basic.ics'

const CACHE_TTL_MS = 10 * 60 * 1000 // 10 分鐘
const FETCH_TIMEOUT_MS = 12_000
const WINDOW_DAYS = 120 // 只看今天往前找 120 天內
const MAX_EVENTS = 20

interface IcsEvent {
  start: Date
  end: Date
  allDay: boolean
  title: string
}

interface CalendarCache {
  fetchedAt: number
  events: IcsEvent[]
}

let cache: CalendarCache | null = null

/** 是否為問「活動／行事曆」類的問題（要動態抓行事曆資料輔助回答） */
export function isCalendarQuestion(text: string): boolean {
  return /行事曆|活動|運動會|校慶|放假|休業式|開學|戶外教育|畢旅|畢業|校外教學|參訪|宣導|演練|講座|疫苗|評量|社團|比賽|最近|近期|下週|下個禮拜|這個月|幾號|幾月/.test(
    text,
  )
}

/** 解析 ICS：DTSTART;VALUE=DATE:20251106（全天）與 DTSTART:20250912T011500Z（UTC 時刻）兩種格式 */
function parseIcsDate(raw: string, allDay: boolean): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(raw.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const d = Number(m[3])
  if (allDay) return new Date(Date.UTC(y, mo, d)) // 全天事件：UTC 0 點 → 台北同日 08:00，日期不變
  return new Date(Date.UTC(y, mo, d, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)))
}

/** 解析 ICS 內容成事件列表 */
export function parseIcs(raw: string): IcsEvent[] {
  // 依 RFC 5545 解開摺行（以空白開頭的續行）
  const unfolded = raw
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, ' ')
    .split('\n')

  const text = (s: string): string => s.replace(/\\n/g, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')

  const events: IcsEvent[] = []
  let cur: Partial<IcsEvent> | null = null
  for (const line of unfolded) {
    if (line.startsWith('BEGIN:VEVENT')) {
      cur = {}
      continue
    }
    if (line.startsWith('END:VEVENT')) {
      if (cur?.start && cur.end && cur.title) events.push(cur as IcsEvent)
      cur = null
      continue
    }
    if (!cur) continue
    if (/^DTSTART[^:]*:/.test(line)) {
      const value = line.slice(line.indexOf(':') + 1)
      const allDay = /VALUE=DATE/.test(line) && !value.includes('T')
      const start = parseIcsDate(value, allDay)
      if (start) cur = { ...cur, start, allDay }
    } else if (/^DTEND[^:]*:/.test(line)) {
      const value = line.slice(line.indexOf(':') + 1)
      const allDay = /VALUE=DATE/.test(line) && !value.includes('T')
      const end = parseIcsDate(value, allDay)
      if (end) cur = { ...cur, end }
    } else if (/^SUMMARY[^:]*:/.test(line)) {
      const title = text(line.slice(line.indexOf(':') + 1)).trim()
      if (title) cur = { ...cur, title }
    }
  }
  return events
}

const dayFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false })

/** 把事件轉成孩子看得懂的時間標籤，例如「11/15」或「11/18 15:00」 */
function label(e: IcsEvent): string {
  const day = dayFmt.format(e.start)
  if (e.allDay) return day
  return `${day} ${timeFmt.format(e.start)}`
}

async function loadEvents(): Promise<IcsEvent[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.events
  try {
    const res = await fetch(CALENDAR_ICS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; classroom-chat-bot)' },
    })
    if (res.ok) {
      const events = parseIcs(await res.text())
      if (events.length > 0) {
        cache = { fetchedAt: Date.now(), events }
        return events
      }
    }
  } catch {
    // Google 日曆暫時抓不到：走無行事曆路徑
  }
  return cache?.events ?? []
}

/** 取出近期活動的清單文字（給 LLM 當上下文）；目前沒有近期資料時回 null */
export async function schoolCalendarContext(): Promise<string | null> {
  const now = Date.now()
  const horizon = now + WINDOW_DAYS * 86_400_000
  const events = (await loadEvents())
    .filter((e) => e.end.getTime() >= now - 86_400_000 && e.start.getTime() <= horizon)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, MAX_EVENTS)
  if (events.length === 0) return null
  const lines = events.map((e) => `- ${label(e)}：${e.title}（${e.title.includes('校慶') ? '大活動' : ''}）`.replace('（）', ''))
  return [
    '【槺榔國小「行政工作行事曆」目前查到的活動（來源：學校 Google 行事曆）】',
    ...lines,
    '※ 回答活動問題時以這份資料為準；上面沒有的活動就誠實說不知道。學校網站 https://klnes.tc.edu.tw 的「校務行事曆」有完整版本。',
  ].join('\n')
}

/** 沒有 LLM 可用時的行事曆罐頭回答（照樣能報出真實的近期活動） */
export async function calendarPlainAnswer(): Promise<string | null> {
  const events = (await schoolCalendarContext())
    ?.split('\n')
    .filter((l) => l.startsWith('-'))
    .slice(0, 6)
  if (!events || events.length === 0) return null
  return `我查了學校的行事曆，目前最近安排的活動：\n${events.join('\n')}\n（完整資料請看學校網站的「校務行事曆」，或打 (04)26562684 詢問）`
}
