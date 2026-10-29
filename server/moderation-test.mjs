// 板規驗證：敏感詞遮蔽 / LLM 回答 / 24 小時顯示（需後端在 ws://localhost:4001/ws）
import WebSocket from 'ws'

const URL = process.env.CHAT_URL ?? 'ws://localhost:4001/ws'
const results = []
const ok = (name) => { results.push(`✔ ${name}`) }

function connect(nickname, color) {
  const ws = new WebSocket(URL)
  const waiters = []
  ws.messages = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    ws.messages.push(msg)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1) }
    }
  })
  ws.next = (pred, timeout = 20000) => new Promise((resolve, reject) => {
    const found = ws.messages.find(pred)
    if (found) return resolve(found)
    const timer = setTimeout(() => reject(new Error('timeout ' + nickname)), timeout)
    waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m) } })
  })
  const ready = new Promise((resolve) => ws.once('open', resolve))
  return ready.then(() => {
    ws.send(JSON.stringify({ type: 'hello', nickname, color }))
    return ws.next((m) => m.type === 'welcome').then(() => ws)
  })
}

const main = async () => {
  const alice = await connect('小美', '#06c755')
  const bob = await connect('阿明', '#3b82f6')

  // 兩人都進大廳
  alice.send(JSON.stringify({ type: 'room:join', roomId: 'lobby' }))
  bob.send(JSON.stringify({ type: 'room:join', roomId: 'lobby' }))
  await alice.next((m) => m.type === 'joined' && m.roomId === 'lobby')
  await bob.next((m) => m.type === 'joined' && m.roomId === 'lobby')

  // ── 1. 敏感詞遮蔽：發送含敏感詞訊息，Alice 自己收到遮蔽通知，Bob 收到遮蔽後文字 ──
  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '這句有fuck跟幹你娘 ft. 測試' }))
  const bobGot = await bob.next((m) => m.type === 'chat' && (m.message.text.includes('＊') || m.message.text === '這句有fuck跟幹你娘 ft. 測試'))
  const masked = bobGot.message.text.includes('＊') || bobGot.message.text.includes('*')
  if (masked) ok(`敏感詞遮蔽 → 「${bobGot.message.text}」`)
  else console.log('✘ 敏感詞未遮蔽:', bobGot.message.text)
  // 私訊提醒
  const notice = await alice.next((m) => m.type === 'chat' && m.message.senderName === '小幫手' && (m.message.text.includes('遮蔽') || m.message.text.includes('不適合')), 8000).catch(() => null)
  if (notice) ok('發送者收到提醒私訊')
  else console.log('ℹ 無私訊提醒（檢查是否所有字都被遮蔽）')

  // 清掉測試訊息痕跡：無 API，看 Supabase 就好
  // ── 2. LLM 智慧答詢：小幫手不在大廳被點名（bot 未開也會回覆？看實作：CALL）──
  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '小幫手，訂餐是什麼時候截止' }))
  const llm = await alice.next((m) => m.type === 'chat' && m.message.senderName === '小幫手' && !m.message.text.includes('遮蔽'), 30000).catch(() => null)
  if (llm && llm.message.text.length > 4) ok(`LLM 回覆 → 「${llm.message.text.slice(0, 40)}…」`)
  else console.log('ℹ LLM 無回覆或超時（罐頭回覆）', llm && llm.message.text)

  // ── 3. 24 小時顯示：加入大廳的 joined.messages 應只含 24 小時內的訊息 ──
  const fresh = await connect('小華', '#f97316')
  fresh.send(JSON.stringify({ type: 'room:join', roomId: 'lobby' }))
  const joined = await fresh.next((m) => m.type === 'joined' && m.roomId === 'lobby')
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const tooOld = joined.messages.filter((m) => m.ts < cutoff)
  if (tooOld.length === 0) ok(`24 小時顯示（載回 ${joined.messages.length} 則皆為 24h 內）`)
  else console.log(`✘ 有 ${tooOld.length} 則超過 24 小時`)

  alice.close(); bob.close(); fresh.close()
  console.log(results.join('\n'))
  console.log('── 驗證完成 ──')
  process.exit(0)
}

main().catch((e) => { console.error('驗證失敗', e.message); process.exit(1) })
