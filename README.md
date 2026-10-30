# 線上聊天室（chat-app）

類似 LINE 的線上聊天室，使用 **Vite + React + TypeScript（前端）** 與 **Node.js + ws（WebSocket 後端）** 開發。

## 功能

- 🀄 暱稱登入 + 自選頭像顏色
- 🉐 大廳（內建、永久）+ 自由建立／加入／退出聊天室
- ⏳ 自建聊天室生命週期：**每人限建 1 間、存活 1 小時、沒有人時立即解散**
- 💬 LINE 風格對話泡泡（自己綠色靠右、他人白色靠左）、頭像、時間
- 📅 日期分隔、加入／離開系統提示
- 🔔 側欄未讀徽章與最新訊息預覽
- ⌨️ 「正在輸入」提示（發送端節流、自動過期）
- 😊 表情符號面板、Enter 送出 / Shift+Enter 換行
- 🔁 斷線自動重連（指數退避）
- ☁️ 對話歷史可存 **Supabase**（各聊天室的完整對話流程、房間、FAQ；未設定時存 JSON 檔）
- 📒 機器人問答**另存** `bot_qa_logs` 表（問題／回答／來源 faq・llm・fallback・tutor・complaint／提問者／房名；房間解散不影響，一樣 14 天後清除）
- 💾 訊息歷史保存於 `server/data/store.json`（重啟不消失；無 Supabase 時）
- 🛡️ 敏感詞自動遮蔽（伺服器端統一過濾，學生輸入與 bot／LLM 回覆都會檢查）
- 🏫 AI 回覆以**適合國小教育**的字句為限（系統提示強制：正向溫和、禁不雅／負面字句），偵測到**抱怨語句**時不走 LLM，統一回覆「洽學校處理」＋學校電話 (04)26562684
- 🕐 對話紀錄政策：畫面只顯示最近 **24 小時**；資料保留 **14 天** 後自動清除
- 🤖 機器人「小幫手」自動答詢，可接多個 LLM 服務輪替備援（限流自動換下一家；見下方說明）
- 🇺🇸 機器人「英文助教」：中文↔英文翻譯 + AI 語音朗讀（見下方說明）

## 聊天室生命週期 ⏳

| 規則                     | 說明                                                       |
| ------------------------ | ---------------------------------------------------------- |
| 每人限建 **1 間**        | 同一暱稱已擁有自建聊天室時，再次建立會被拒絕（以暱稱判定，重連也有效） |
| 存活 **1 小時**          | 建立一小時後自動解散；解散前會在房內通知並自動帶成員回大廳     |
| **沒有人就消失**         | 最後一位成員離開的瞬間，聊天室立即從清單移除                   |
| 大廳                     | 永久存在，不受上述規則影響                                   |

逾時時間可用環境變數 `CHAT_ROOM_LIFETIME_MS` 調整（毫秒）。

## 機器人「小幫手」🤖

聊天室標頭有「🤖 機器人開／關」按鈕（大廳預設開、新建房間預設關）。

| 觸發方式                               | 行為                             |
| -------------------------------------- | -------------------------------- |
| 訊息中包含「**小幫手**」                | 一定會回覆（打招呼／解答）       |
| 開啟時訊息**命中自訂 FAQ 關鍵字**        | 自動回答該條 FAQ                 |
| **私人小幫手房**（widget 開的房、房內只有房主本人） | 每一句都視同點名，保證有回應 |
| `斜線指令`                              | 只有自己看得到指令，結果依性質公開或私回 |

### 指令

| 指令               | 說明                     | 回覆範圍 |
| ------------------ | ------------------------ | -------- |
| `/說明`            | 指令總覽                 | 私回     |
| `/時間`            | 現在時間                 | 公開     |
| `/成員`            | 房間成員清單             | 公開     |
| `/骰子`            | 擲骰子 1–100             | 公開     |
| `/笑話`            | 隨機笑話                 | 公開     |
| `/教 關鍵字=回答`  | 教機器人自動回答（FAQ）  | 私回確認 |
| `/忘 關鍵字`       | 刪除一條 FAQ             | 私回確認 |
| `/清單`            | 列出目前學會的 FAQ       | 私回     |

FAQ 會保存在 `server/data/store.json`，重啟不會忘記。
bot 回覆前會先顯示「正在輸入…」延遲一陣子再回答，效果自然。

### 智慧答詢：接 LLM API（選用，支援多路由備援）

設定 `CHAT_LLM_BASE_URL` + `CHAT_LLM_MODEL` 後，「小幫手」被點名時會改用 **OpenAI 相容端點**（`chat/completions`）回答，並帶入最近對話上下文。

**多路由備援**：把第二、三、四家服務填進成組的 `CHAT_LLM2_*` ／ `CHAT_LLM3_*` ／ `CHAT_LLM4_*`（一組 = `*_BASE_URL` + `*_MODEL` + `*_API_KEY`）。呼叫時依序嘗試，**一家限流／逾時／失敗就自動換下一家**，全部失敗才退回內建罐頭回覆 — 線上服務永遠答得出話。

本專案線上環境的四層配置：

| 路由 | 服務 | `*_BASE_URL` | 取得 key |
| --- | --- | --- | --- |
| `CHAT_LLM_*`     | OpenRouter（自動路由免費模型） | `https://openrouter.ai/api/v1` | https://openrouter.ai/settings/keys |
| `CHAT_LLM2_*`    | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | https://aistudio.google.com/apikey |
| `CHAT_LLM3_*`    | Groq | `https://api.groq.com/openai/v1` | https://console.groq.com/keys |
| `CHAT_LLM4_*`    | Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/<AccountID>/ai/v1` | https://dash.cloudflare.com/profile/api-tokens（用 Workers AI 模板） |

- **本機（零成本）**：`CHAT_LLM_BASE_URL=http://localhost:11434/v1`（Ollama，key 填 `ollama`）或 `http://localhost:1234/v1`（LM Studio）。
- 範例模型名：`openrouter/free`、`gemini-3.5-flash`、`qwen/qwen3.8-27b`、`@cf/meta/llama-3.3-70b-instruct-fp8-fast`。
- **`CHAT_LLM<n>_EXTRA`**（選用）：JSON 字串，整包合併進請求 body。Gemini 思考模型建議設 `{"reasoning_effort":"none"}`，避免 reasoning tokens 吃光回覆長度又拖慢回應。
- 未設定時走 `server/data/store.json` 罐頭回覆；`.env` 檔支援範例見 `.env.example`。

### 浮動機器人外掛（嵌入任何網頁）💬

在**任何網頁**的 `</body>` 前貼一行 script，右下角就會出現「小幫手」浮動按鈕：

```html
<script src="https://你的聊天室網址/widget.js" defer></script>
```

- **零依賴、單檔**：`public/widget.js` 以 Shadow DOM 注入，不影響宿主頁樣式跨網站放置也沒問題（用 `wss` 自動安全連線）。
- **預設行為**：開啟時自動建立一間私人「小幫手」房並啟用機器人；離開（關閉按鈕）房間自動解散，不留紀錄、不影響大廳。一小時內**重新整理／再開頁面**會自動領回上次那間房繼續聊，不會被「只能開一間」擋住。
- **每句必回**：私人小幫手房裡的每一句話都視同點名（不用打「小幫手」三個字也會回）；送出後 30 秒沒收到任何回覆，狀態列會提示再送一次。
- **即時查證（不空答）**：問到「學校的事情」時，伺服器會現場查資料再回答，而不是要你自己去看網站：
  1. **學校網站**：校務佈告欄最新公告（`school.tc.edu.tw` 公開頁）
  2. **校務行事曆**：學校 Google 行事曆的 ICS（活動日期直接答得出來，快取 10 分鐘）
  3. **政府資料開放平臺**（`data.gov.tw`）：補充教育局級的公開資料集
  查到的資料會餵給 AI（有日期、有來源）；查不到才會說「不知道或引導洽學校」，**絕不編造活動**。
- **客製參數**：`data-nickname`（預設顯示暱稱；**每台瀏覽器會自動加上穩定編號**，如「槺榔國小訪客‑12」，同一時間多名訪客可各自開私人房不打架）、`data-accent`（主題色）、`data-position`（right/left）、`data-image`（**按鈕用圖片**，例如校徽；標頭頭像也會跟著換）、`data-room`（改連指定房間）、`data-greeting`（開場白）。
- **提問上限 50 字**：輸入框最多 50 字（開場白有提示、右下有計數器），避免學生一次丟太長的問題。
- **API**：`window.ChatWidget.open() / close() / toggle() / config({ accent, nickname, ... })`。
- 完整參數表與示範：部署後打開 `https://你的聊天室網址/widget-demo.html`。

## 機器人「英文助教」🇺🇸

中文翻英文並**自動朗讀**，翻譯走 Google 翻譯公共端點（不需 API 金鑰，需要對外網路）。

| 使用方式                             | 效果                                           |
| ------------------------------------ | ---------------------------------------------- |
| 訊息中說「**英文助教** ＋想翻的內容」 | 中文 → 英文，並用英語音調唸出來                 |
| `/翻譯 內容`                          | 同上（英文內容則翻回中文）                     |
| 點標頭「**🇺🇸 英文教室**」按鈕         | 進入教室模式：之後傳的每則訊息自動翻譯+朗讀，不想用再點一次離開 |

- **AI 語音**：伺服器以 [msedge-tts](https://www.npmjs.com/package/msedge-tts)（Edge「朗讀」神經語音 API，**不需金鑰**）產生自然發音 mp3 廣播給房間——英文用 `en-US-AvaNeural`、中文用 `zh-TW-HsiaoChenNeural`；自動播放失敗時退回瀏覽器內建 Web Speech API。
- 標頭「🔊 朗讀開／關」可全域開關自動朗讀（設定記在 localStorage）。
- 英文助教的英文訊息旁有 🔊 按鈕，點一下可重聽（優先播放伺服器 AI 語音）。
- 翻譯方向自動判斷：中文為主 → 翻成英文；英文為主 → 翻回中文。

## 使用

```bash
cd chat-app
npm install
npm run dev        # 同時啟動後端 (4001) 與前端 (5199)
```

打開 http://localhost:5199，輸入暱稱即可開始聊天。

**正式模式**（單一埠同時提供網頁＋WebSocket）：

```bash
npm run build && npm start   # 打開 http://localhost:4001
```

## 部署到雲端（Render 免費方案）

本專案可在 **Render** 的免費方案上執行（支援 WebSocket），步驟：

1. 將 repo 推上 GitHub。
2. 到 [render.com](https://render.com) 註冊（可用 GitHub 帳號登入）→ **New → Blueprint** → 選取這個 repo，會自動讀取 `render.yaml`。
3. 按 **Create** 完成部署，得到網址 `https://你的服務名.onrender.com`，同學打開網址即可使用。

注意事項（免費方案）：

- **閒置 15 分鐘會休眠**，下次開啟約需 30–60 秒喚醒（上課時先開網頁點一下即可）。
- **沒有持久磁碟**：重回部署／重啟後 `server/data/store.json` 的歷史訊息會清空（FAQ 也要重新教）。
- 512MB RAM、每月 5GB 流量，一個班級的聊天室綽綽有餘。
- 「小幫手」智慧答詢需要的 `CHAT_LLM_*` 環境變數，在 Render 服務的 **Environment** 分頁設定。

其他免費/低價選項：Railway（試用送 $5 額度 30 天）、Fly.io（按用量計費，約 $2–3/月起）。

## 其他指令

| 指令                 | 說明                                          |
| -------------------- | --------------------------------------------- |
| `npm run dev:server` | 只跑後端（tsx watch）                         |
| `npm run dev:client` | 只跑前端（Vite）                              |
| `npm start`          | 正式模式：單埠服務網頁＋WebSocket（需先 build） |
| `npm run smoke`      | 煙霧測試（需後端執行中）                       |
| `npm run typecheck`  | TypeScript 型別檢查                           |
| `npm run build`      | 前端正式建置                                  |

## 架構

```
chat-app/
├─ .env.example          # 環境變數範例（LLM／埠／聊天室壽命）
├─ shared/protocol.ts    # 前後端共用的 WebSocket 傳輸協定型別
├─ server/index.ts       # WebSocket 伺服器：房間（生命週期）、成員、廣播、心跳、持久化
├─ server/bot.ts         # 機器人：小幫手（FAQ）＋英文助教（翻譯）
├─ server/moderation.ts  # 敏感詞自動遮蔽（內建清單 + CHAT_BLOCKED_WORDS 追加）
├─ server/llm.ts       # LLM 智慧答詢：多路由輪替備援（OpenAI 相容端點；全失敗時退回）
├─ server/tts.ts         # AI 語音（Edge 神經語音，msedge-tts）
├─ server/db.ts          # Supabase 持久化（rooms/messages/faqs；未設定時退回 JSON）
├─ public/widget.js      # 浮動機器人外掛（其他網頁一行 script 嵌入；Shadow DOM）
├─ public/widget-demo.html # 外掛示範頁
├─ server/smoke.mjs      # 端對端煙霧測試
├─ server/expiry-test.mjs # 聊天室逾時解散測試（配合 CHAT_ROOM_LIFETIME_MS）
└─ src/
   ├─ hooks/useChat.ts   # 連線狀態機、rooms/messages/unread/typing/音訊快取、重連
   ├─ components/        # LoginScreen / Sidebar / ChatWindow / MessageList / Composer / NewRoomModal
   ├─ utils/speech.ts    # 語音播放改良（AI 語音轉址 + Web Speech API 備援）
   └─ styles.css         # LINE 風格樣式（品牌綠 #06c755）
```

前端一律以同源 `ws(s)://<host>/ws` 連線；開發時由 Vite proxy 轉發到 `ws://localhost:4001`。

## 設定

| 環境變數                   | 預設       | 說明                                      |
| -------------------------- | ---------- | ----------------------------------------- |
| `CHAT_PORT` / `PORT`       | 4001       | 後端監聽埠（雲端平台通常注入 `PORT`）      |
| `CHAT_LLM_BASE_URL`        | （未設定） | LLM 主路由（OpenAI / Gemini / Groq / LM Studio …） |
| `CHAT_LLM_MODEL`           | （未設定） | LLM 模型名稱；與 BASE_URL 同設才啟用               |
| `CHAT_LLM_API_KEY`         | `ollama`   | LLM 金鑰                                           |
| `CHAT_LLM2_*` / `CHAT_LLM3_*` / `CHAT_LLM4_*` | （未設定） | 備援路由（同欄位成組）；主路由限流時依序自動轉換 |
| `CHAT_LLM<n>_EXTRA`        | （未設定） | JSON 字串，合併進 LLM 請求 body（Gemini 建議 `{"reasoning_effort":"none"}`） |
| `CHAT_ROOM_LIFETIME_MS`    | 3600000    | 自建聊天室存活毫秒數（1 小時）              |
| `SUPABASE_URL`             | （未設定） | Supabase 專案網址；與下方 key 同設才啟用雲端儲存 |
| `SUPABASE_SERVICE_ROLE_KEY`| （未設定） | Supabase service key（伺服器專用，勿外洩）  |
| `CHAT_BLOCKED_WORDS`       | （內建清單） | 追加敏感詞（逗號分隔；內建見 `server/moderation.ts`） |
| `CHAT_VISIBILITY_MS`       | 86400000   | 對話呈現範圍毫秒數（畫面只顯示最近 24 小時） |
| `CHAT_RETENTION_MS`        | 1209600000 | 對話保留期毫秒數（14 天，逾時自動清除）      |

支援 `.env` 檔（零相依注入；範例見 `.env.example`），正式環境變數優先於 `.env`。

### Supabase 雲端儲存（選用）

設定 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` 之後，所有聊天室的**完整對話流程**（含 bot 回覆與系統訊息）、房間清單與 FAQ 都會即時寫進 Supabase：

| 資料表           | 內容                                        |
| ---------------- | ------------------------------------------- |
| `chat_rooms`     | 房間：名稱、建立者、存活期限、機器人開關     |
| `chat_messages`  | 每間房的完整訊息流程（系統訊息也會存）       |
| `chat_faqs`      | 小幫手學會的 FAQ                            |

- 資料表由 `server/db.ts` 用 REST API 讀寫（PostgREST），**資料表啟用了 RLS 且不開公開 policy**：只有伺服器（service key）能存取，瀏覽器側拿不到任何資料。
- 未設定環境變數時自動退回 `server/data/store.json`，功能不受影響。
- 遷移檔見 Supabase CLI（migration `create_chat_rooms_messages_faqs`）。

## 訊息協定（摘錄）

- Client → Server：`hello`、`chat`、`typing`、`room:create`、`room:join`、`room:leave`、`bot`、`tutor`
- Server → Client：`welcome`、`rooms`、`joined`、`chat`、`typing`、`audio`、`room:closed`、`error`

詳細型別見 `shared/protocol.ts`。
