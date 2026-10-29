/** 時間格式 HH:MM（24 小時制） */
export function formatTime(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 日期分隔標籤：今天／昨天／M月D日 */
export function formatDayLabel(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayMs = 86_400_000

  if (startOfThatDay === startOfToday) return '今天'
  if (startOfToday - startOfThatDay === dayMs) return '昨天'

  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  const weekday = weekdays[date.getDay()]
  return `${date.getMonth() + 1}月${date.getDate()}日（${weekday}）`

}

/** 側邊欄列表用：今天的訊息只顯示 HH:MM，否則顯示日期 */
export function formatListTime(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  if (startOfThatDay === startOfToday) return formatTime(ts)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 是否為同一天（用於日期分隔線） */
export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}
