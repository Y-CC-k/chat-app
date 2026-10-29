// 逾時解散測試：需以 CHAT_ROOM_LIFETIME_MS=3000 CHAT_PORT!==4001 啟動 server 後執行
import WebSocket from 'ws'
const URL = `ws://localhost:${process.env.CHAT_PORT ?? 4102}/ws`
const ws = new WebSocket(URL)
const inbox = []
ws.on('message', (d) => inbox.push(JSON.parse(d.toString())))
await new Promise((r) => ws.once('open', r))
ws.send(JSON.stringify({ type: 'hello', nickname: '壽命測試員' }))
await new Promise((r) => setTimeout(r, 400))
ws.send(JSON.stringify({ type: 'room:create', name: '短命房' }))
await new Promise((r) => setTimeout(r, 400))
const created = inbox.filter((m) => m.type === 'joined').map((m) => m.roomId).pop()
if (!created) throw new Error('房間建立失敗')
const establishedAt = inbox.length
console.log('✔ 房間已建立:', created.slice(0, 8))
await new Promise((r) => setTimeout(r, 17000))
const after = inbox.slice(establishedAt)
const closed = after.find((m) => m.type === 'room:closed' && m.roomId === created)
const gone = after.find((m) => m.type === 'rooms' && !m.rooms.some((r) => r.id === created))
if (closed && gone) console.log('✔ 逾時解散: room:closed 已送達（' + closed.reason + '）且清單已移除')
else throw new Error('逾時解散未發生: closed=' + !!closed + ' gone=' + !!gone)
ws.close()
console.log('逾時測試通過 ✅')
process.exit(0)
