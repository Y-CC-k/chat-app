// 一次性腳本：刪除 Supabase chat_messages 裡「加入/離開房間」的舊系統提示
import { readFileSync } from 'node:fs'

const env = readFileSync('.env', 'utf8')
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim()
const url = get('SUPABASE_URL').replace(/\/+$/, '')
const key = get('SUPABASE_SERVICE_ROLE_KEY')

const filter =
  'kind=eq.system&or=(text.like.*加入了「*,text.like.*離開了「*)'
const res = await fetch(`${url}/rest/v1/chat_messages?${filter}`, {
  method: 'DELETE',
  headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=representation' },
})
const rows = res.ok ? await res.json() : null
console.log(res.ok ? `已刪除 ${Array.isArray(rows) ? rows.length : 0} 則加入/離開系統訊息` : `失敗 HTTP ${res.status}: ${await res.text().catch(() => '')}`)
