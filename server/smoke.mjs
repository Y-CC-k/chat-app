// 煙霧測試：模擬兩位使用者連線、建立房間、互傳訊息
import WebSocket from 'ws'

const URL = `ws://localhost:${process.env.CHAT_PORT ?? 4001}/ws`

function connect(name) {
  const ws = new WebSocket(URL)
  ws.name = name
  ws.inbox = []
  ws.waiters = []

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (process.env.SMOKE_DEBUG) {
      const label = msg.type === 'chat' ? `${msg.message.kind}:${msg.message.text.slice(0, 30)}` : msg.type
      console.log(`  [debug] ${name} < ${label}`)
    }
    ws.inbox.push(msg)
    // 通知所有仍在等待的 waiter（各自自行判斷 filter，由坑自行移除）
    for (const waiter of [...ws.waiters]) waiter()
  })

  ws.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function next(ws, filter, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const found = ws.inbox.find(filter)
    if (found) return resolve(found)
    const timer = setTimeout(() => {
      const index = ws.waiters.indexOf(waiter)
      if (index >= 0) ws.waiters.splice(index, 1)
      reject(new Error(`${ws.name} 等待訊息逾時`))
    }, timeout)
    // waiter 被呼叫時重新掃描收件匣（包含先前已收到的訊息）
    const waiter = () => {
      const found = ws.inbox.find(filter)
      if (found) {
        clearTimeout(timer)
        const index = ws.waiters.indexOf(waiter)
        if (index >= 0) ws.waiters.splice(index, 1)
        resolve(found)
      }
    }
    ws.waiters.push(waiter)
  })
}

async function main() {
  const alice = connect('Alice')
  const bob = connect('Bob')
  await Promise.all([alice.opened, bob.opened])

  // 登入
  alice.send(JSON.stringify({ type: 'hello', nickname: '小美', color: '#ec4899' }))
  bob.send(JSON.stringify({ type: 'hello', nickname: '阿明', color: '#3b82f6' }))

  const aliceWelcome = await next(alice, (m) => m.type === 'welcome')
  const bobWelcome = await next(bob, (m) => m.type === 'welcome')
  console.log('✔ welcome:', aliceWelcome.user.nickname, '/', bobWelcome.user.nickname)

  // Alice 建立房間
  alice.send(JSON.stringify({ type: 'room:create', name: '專案討論' }))
  const aliceJoined = await next(alice, (m) => m.type === 'joined')
  const roomId = aliceJoined.roomId
  console.log('✔ 房間建立:', roomId)

  // 第二間房應該被拒絕（每人限建 1 間）
  alice.send(JSON.stringify({ type: 'room:create', name: '想蓋第二間' }))
  const limitError = await next(alice, (m) => m.type === 'error' && m.message.includes('只能建立'))
  console.log('✔ 限建 1 間:', limitError.message.slice(0, 26))

  // Bob 加入房間
  bob.send(JSON.stringify({ type: 'room:join', roomId }))
  const bobJoined = await next(bob, (m) => m.type === 'joined' && m.roomId === roomId)
  console.log('✔ Bob 取得歷史訊息數:', bobJoined.messages.length)

  // Bob 收到「加入了」的系統訊息才算成員完成
  await next(bob, (m) => m.type === 'chat' && m.message.kind === 'system' && m.message.roomId === roomId)
  console.log('✔ 系統歡迎訊息 OK')

  // 互相傳訊
  alice.send(JSON.stringify({ type: 'chat', roomId, text: '哈囉！' }))
  const msg1 = await next(bob, (m) => m.type === 'chat' && m.message.text === '哈囉！')
  console.log('✔ 廣播訊息:', msg1.message.senderName, '→', msg1.message.text)

  bob.send(JSON.stringify({ type: 'typing', roomId, typing: true }))
  const typing = await next(alice, (m) => m.type === 'typing' && m.typing)
  console.log('✔ 打字提示:', typing.nickname)

  // ── 機器人「小幫手」 ──────────────────────────────────────────

  // 教一條 FAQ（在大廳教，大廳預設開啟 bot）
  const lobby = await next(alice, (m) => m.type === 'rooms' && m.rooms[0]?.botEnabled === true)
  console.log('✔ 大廳預設啟用機器人')
  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '/教 訂餐=明天中午前找班長登記！' }))
  const learned = await next(alice, (m) => m.type === 'chat' && m.message.senderId === 'bot-helper' && m.message.text.startsWith('✅'))
  console.log('✔ /教 學習:', learned.message.text.slice(0, 26))

  // 命中關鍵字自動回答（公開給全房）
  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '請問訂餐流程是什麼？' }))
  const auto = await next(alice, (m) => m.type === 'chat' && m.message.text.includes('找班長登記'))
  console.log('✔ FAQ 自動回答:', auto.message.text)

  // 點名 bot 得到回覆
  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '小幫手，你好' }))
  const greet = await next(alice, (m) => m.type === 'chat' && m.message.senderId === 'bot-helper' && m.message.text.includes('小幫手'))
  console.log('✔ 點名回覆:', greet.message.text.slice(0, 26))

  // /時間拒絕指令
  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '/時間' }))
  const timeMsg = await next(alice, (m) => m.type === 'chat' && m.message.senderId === 'bot-helper' && m.message.text.startsWith('現在時間'))
  console.log('✔ /時間 指令:', timeMsg.message.text)

  // /清單（僅本人收到）
  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '/清單' }))
  const list = await next(alice, (m) => m.type === 'chat' && m.message.text.startsWith('📚'))
  const bobGotList = bob.inbox.some((m) => m.type === 'chat' && m.message?.text?.startsWith('📚'))
  if (bobGotList) throw new Error('私人指令不該廣播給其他人')
  console.log('✔ /清單 僅本人可見:', list.message.text.split('\n')[1]?.slice(0, 24))

  // 建立房間預設關閉 bot（改由阿明建立，小美只能有 1 間）
  bob.send(JSON.stringify({ type: 'room:create', name: 'bot測試房' }))
  const created = await next(bob, (m) => m.type === 'joined')
  const rooms1 = await next(bob, (m) => m.type === 'rooms' && m.rooms.some((r) => r.id === created.roomId && r.botEnabled === false))
  bob.send(JSON.stringify({ type: 'bot', roomId: created.roomId, enabled: true }))
  await next(bob, (m) => m.type === 'rooms' && m.rooms.find((r) => r.id === created.roomId)?.botEnabled === true)
  console.log('✔ 房間機器人開關（預設關）')

  // ── 英文助教 ─────────────────────────────────────────────────

  // 點名翻譯（需要對外網路）
  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '英文助教 今天天氣很好' }))
  const en1 = await next(alice, (m) => m.type === 'chat' && m.message.senderId === 'bot-en-tutor', 12000)
  console.log('✔ 中文→英文翻譯:', en1.message.text)
  if (!/^[A-Za-z]/.test(en1.message.text)) throw new Error(`翻譯結果應為英文: ${en1.message.text}`)

  // /翻譯 指令（英文 → 中文）
  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '/翻譯 Hello everyone, nice to meet you' }))
  const en2 = await next(alice, (m) => m.type === 'chat' && m.message.senderId === 'bot-en-tutor' && m.message.id !== en1.message.id, 12000)
  console.log('✔ 英文→中文翻譯:', en2.message.text)
  if (!/[\u4e00-\u9fff]/.test(en2.message.text)) throw new Error(`翻譯結果應為中文: ${en2.message.text}`)

  // ── 英文教室模式：點按鈕進入後，訊息自動翻譯 ────────────────
  alice.send(JSON.stringify({ type: 'tutor', enabled: true }))
  const tutorConfirm = await next(alice, (m) => m.type === 'chat' && m.message.senderId === 'bot-en-tutor' && m.message.text.includes('英文教室'))
  const seenTutorIds = [en1.message.id, en2.message.id, tutorConfirm.message.id]
  console.log('✔ 進入英文教室（確認訊息）')

  alice.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '我想吃漢堡' }))
  const en3 = await next(
    alice,
    (m) => m.type === 'chat' && m.message.senderId === 'bot-en-tutor' && /^[A-Za-z]/.test(m.message.text),
    15000,
  )
  console.log('✔ 教室模式自動翻譯:', en3.message.text)
  if (!/^[A-Za-z]/.test(en3.message.text)) throw new Error(`教室模式應自動翻成英文: ${en3.message.text}`)

  // AI 語音（Edge TTS）：等 en3 的音檔廣播
  const audioMsg = await next(alice, (m) => m.type === 'audio' && m.messageId === en3.message.id, 20000)
  const audioSize = Buffer.byteLength(audioMsg.data, 'base64')
  console.log(`✔ AI 語音廣播: ${(audioSize / 1024).toFixed(1)} KB (voice=${audioMsg.voice})`)
  if (audioSize < 1024) throw new Error('語音資料太小，可能不完整')

  // 阿明沒進教室，訊息不會被翻譯
  bob.send(JSON.stringify({ type: 'chat', roomId: 'lobby', text: '我一般訊息不翻譯' }))
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const bobDirect = bob.inbox.some((m) => m.type === 'chat' && m.message?.text === '我一般訊息不翻譯')
  if (!bobDirect) throw new Error('阿明的訊息應該正常廣播')
  console.log('✔ 非教室模式成員不受影響')

  alice.send(JSON.stringify({ type: 'tutor', enabled: false }))
  await next(alice, (m) => m.type === 'chat' && m.message.text.includes('恢復一般聊天'))
  console.log('✔ 離開英文教室')



  // ── 房間壽命規則 ─────────────────────────────────────────────
  // 阿明離開自己的房間 → 0 人 → 立刻解散
  const aliceInboxLen = alice.inbox.length
  bob.send(JSON.stringify({ type: 'room:leave', roomId: created.roomId }))
  await next(bob, (m) => m.type === 'rooms' && !m.rooms.some((r) => r.id === created.roomId))
  const aliceStillHas = alice.inbox.slice(aliceInboxLen).some((m) => m.type === 'rooms' && m.rooms.some((r) => r.id === created.roomId))
  if (aliceStillHas) throw new Error('0 人的聊天室應該立即消失')
  console.log('✔ 聊天室 0 人即消失')

  // 房間清單
  bob.send(JSON.stringify({ type: 'room:leave', roomId }))
  await next(alice, (m) => m.type === 'rooms' && m.rooms.find((r) => r.id === roomId)?.members.length === 1)
  console.log('✔ 離開房間後成員數更新')

  alice.close()
  bob.close()
  console.log('\n全部煙霧測試通過 ✅')
  process.exit(0)
}

main().catch((error) => {
  console.error('煙霧測試失敗 ❌', error)
  process.exit(1)
})
