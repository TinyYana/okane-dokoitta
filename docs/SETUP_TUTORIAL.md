# 架設教學（從零開始）

這份教學帶你把 okane-dokoitta 完整架起來：資料庫、網站（PWA）、Discord 提醒、AI 輔助。
目標讀者是「會用終端機，但沒架過網站服務」的人——每一步都給指令，照抄可用。
已經很熟部署的人可以直接看精簡版 `docs/DEPLOYMENT.md`。

架好之後你會有：

- 一個自己的記帳網站（手機可「加入主畫面」變成 App）
- PostgreSQL 資料庫，資料全在你自己手上
- （選配）Discord bot：`/finance` 查詢、繳款提醒私訊
- （選配）AI 輔助：每個使用者自己接自己的模型，伺服器不用任何 AI 金鑰

## 0. 你需要準備什麼

| 項目 | 說明 |
|---|---|
| 一台主機 | 家裡的電腦、樹莓派、或月付幾十塊的 VPS 都行；RAM 1GB 就夠 |
| 網域（強烈建議） | PWA 安裝、Passkey 登入、Discord 整合都需要 HTTPS，有網域才好辦 |
| Docker | 跟著[官方安裝指南](https://docs.docker.com/engine/install/)裝 Docker 與 docker compose |
| Git | 抓程式碼用 |

> 沒有 Docker、只想在自己電腦試玩？看最後面的「附錄：本機試玩（dev-lite）」。

## 1. 抓程式碼

```bash
git clone https://github.com/TinyYana/okane-dokoitta.git
cd okane-dokoitta
```

## 2. 填環境變數

```bash
cp .env.example .env
```

打開 `.env`，至少要填這幾個（其他留空就是「停用該功能」，之後隨時可補）：

```bash
# 資料庫密碼：自己想一個（只有 compose 內部用，不對外）
OKANE_DOKOITTA_DB_PASSWORD=請換成隨機長密碼

# 兩條連線字串都指向 compose 裡的 db 服務，密碼跟上面同一個
OKANE_DOKOITTA_DATABASE_URL=postgres://okane:請換成隨機長密碼@db:5432/okane
OKANE_DOKOITTA_MIGRATE_DATABASE_URL=postgres://okane:請換成隨機長密碼@db:5432/okane

# 對外網址（之後設定反向代理用的網域；先架起來試也可以填 http://localhost:3000）
OKANE_DOKOITTA_BASE_URL=https://okane.example.com

# 兩把金鑰：用下面指令各產生一把，直接貼上
OKANE_DOKOITTA_SESSION_SECRET=
OKANE_DOKOITTA_FILE_KEY=
```

產生金鑰（跑兩次，分別貼給 SESSION_SECRET 與 FILE_KEY）：

```bash
openssl rand -base64 48
```

> 沒有 openssl 的話：`docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`

`.env` 裡是你的密碼與金鑰，**永遠不要 commit 進 git**（`.gitignore` 已擋）。

若要讓 VT 等美股／美國 ETF 自動更新報價，再到 Finnhub 建立 API token，填入：

```bash
OKANE_DOKOITTA_FINNHUB_TOKEN=你的_token
```

這是伺服器端 secret，不會送到瀏覽器。台股上市證券直接使用臺灣證券交易所 OpenAPI，不需要 token；未設定 Finnhub 時只會停用美股報價，不影響記帳與台股報價。

## 3. 建資料庫、跑 migration、啟動

```bash
docker compose build            # 第一次要幾分鐘
docker compose up -d db         # 先開資料庫
docker compose run --rm app migrate   # 建立資料表（每次升級後也要跑）
docker compose up -d            # 全部啟動
```

看 log 確認活著：

```bash
docker compose logs -f app
# 看到 [okane-dokoitta] api listening on :3000 就成功
```

## 4. 第一次開啟與帳號

瀏覽器開 `http://主機IP:3000`（或先跳到第 5 步設好 HTTPS 再開網域）。

- **第一個註冊的帳號自動成為管理者**——所以架好先自己註冊。
- 預設註冊模式是**邀請制**：其他人要註冊，由你在「設定 → 邀請其他使用者」產生一次性邀請碼。
  想全開或全關：`.env` 設 `OKANE_DOKOITTA_REGISTRATION_MODE=open` 或 `closed` 後 `docker compose up -d` 重啟。
- 手機開網站 →「加入主畫面」就是 App。

## 5. HTTPS（用 Caddy，兩行設定）

PWA 離線功能、Passkey、Discord OAuth 都要 HTTPS。最省事的是 [Caddy](https://caddyserver.com/)——自動申請與續期憑證。
在主機上裝好 Caddy 後，`/etc/caddy/Caddyfile` 寫：

```text
okane.example.com {
    reverse_proxy localhost:3000
}
```

`sudo systemctl reload caddy` 之後，`https://okane.example.com` 就通了。
記得 `.env` 的 `OKANE_DOKOITTA_BASE_URL` 要填這個網域，改完重啟 app。

> 家裡沒固定 IP？Cloudflare Tunnel 也可以達到同樣效果（免開 port），見其官方文件。

## 6. Discord 整合（選配，但提醒功能主要靠它）

提醒（繳款、結帳、餘額不足）**優先走 Discord 私訊**；瀏覽器推播只是備援。值得花十分鐘設。

### 6.1 建立 Discord 應用程式

1. 開 [Discord Developer Portal](https://discord.com/developers/applications) →「New Application」，取名（例：記帳小幫手）。
2. **General Information** 頁：記下 `Application ID` 與 `Public Key`。
3. **OAuth2** 頁：記下 `Client Secret`（Reset Secret 才看得到）；在 **Redirects** 加上：
   `https://okane.example.com/api/discord/oauth/callback`
4. **Bot** 頁：記下 `Token`（Reset Token 才看得到）。

### 6.2 填進 .env 並重啟

```bash
OKANE_DOKOITTA_DISCORD_APP_ID=剛剛的 Application ID
OKANE_DOKOITTA_DISCORD_PUBLIC_KEY=剛剛的 Public Key
OKANE_DOKOITTA_DISCORD_BOT_TOKEN=剛剛的 Bot Token
OKANE_DOKOITTA_DISCORD_CLIENT_SECRET=剛剛的 Client Secret
```

```bash
docker compose up -d
```

### 6.3 設定互動端點

回 Developer Portal 的 **General Information**，把 **Interactions Endpoint URL** 填：

```text
https://okane.example.com/api/discord/interactions
```

儲存時 Discord 會打一發驗證請求——你的服務要先跑著、HTTPS 要通，才會儲存成功。

### 6.4 註冊 /finance 指令（一次性，或指令定義變更時重跑）

服務已經跑起來、`.env`／secret 也設定好了以後，直接到記帳網站「設定 → Discord 與通知」按**重新註冊指令**——正式站用自己已有的設定去打 Discord API，不用再把 App ID／Bot Token 貼到終端機。

沒有已部署站台可以打這顆按鈕的情境（例如還沒 `docker compose up -d`，或想在本機單獨跑一次），才用腳本：

```bash
docker compose run --rm app node /app/scripts/discord-register-commands.mjs
```

（或在任何有 Node 的機器上，設好那兩個環境變數後 `node scripts/discord-register-commands.mjs`。）全域指令生效最多要等約 1 小時；兩種方式都是冪等的 `PUT`，重跑無害。

### 6.5 邀請 bot、連結帳號

1. Developer Portal → OAuth2 → URL Generator：勾 `bot`，產生的邀請連結開起來，把 bot 加進你的（私人）伺服器——bot 要能私訊你，你們得共處至少一個伺服器。
2. 回記帳網站「設定 → Discord 與通知」按**連結 Discord**，完成 OAuth。
3. 在 Discord 打 `/finance status` 測試；提醒之後會自動私訊你。

金額顯示有隱私模式（完整／模糊／僅異常／隱藏），在設定頁調。

## 7. 瀏覽器推播（選配，Discord 的備援）

沒連 Discord 的使用者可以退而求其次用瀏覽器推播。要一對 VAPID 金鑰：

```bash
docker run --rm node:22-alpine npx --yes web-push generate-vapid-keys
```

把輸出填進 `.env`：

```bash
OKANE_DOKOITTA_VAPID_PUBLIC_KEY=...
OKANE_DOKOITTA_VAPID_PRIVATE_KEY=...
OKANE_DOKOITTA_VAPID_CONTACT_EMAIL=you@example.com
```

重啟後，使用者在「設定」頁按「開啟這台裝置的推播」。

## 8. AI 輔助（選配；每個使用者自己接）

**伺服器不用設定任何東西。** AI 是 BYOK（bring your own key）：每個使用者在
「設定 → AI 輔助」貼上自己的 OpenAI 相容端點、模型名稱、（選填）API key，測試連線、打開啟用就好。
AI 只幫忙整理帳單文字與解釋對帳結果，永遠不會自己動帳本；不設定也完全不影響任何功能。

常見接法：

| 想用什麼 | 端點填什麼 | 模型例 | key |
|---|---|---|---|
| 自己電腦跑（免費） | `http://localhost:11434/v1`（[Ollama](https://ollama.com)） | `qwen3:8b` | 不用 |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/<帳號ID>/ai/v1` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | CF API Token（Workers AI 權限） |
| OpenRouter | `https://openrouter.ai/api/v1` | 站上任選 | OpenRouter key |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` 等 | OpenAI key |

> 自架在別台機器的 Ollama，端點就填那台的位址；可填 API 根路徑或完整 `/chat/completions` URL。若 provider 回 429，畫面會依 `Retry-After` 提示多久後再試；若回 5xx，則保留上游錯誤訊息供判斷。系統不會自動重送付費或受限請求。

## 9. 備份與還原

資料庫是唯一真相，定期備份它：

```bash
# 備份（產出的檔案收去別台機器／雲端）
docker compose exec db pg_dump -U okane okane > okane-backup-$(date +%F).sql

# 還原（新機器上：先做完第 3 步的 migrate，再灌回去）
cat okane-backup-2026-07-18.sql | docker compose exec -T db psql -U okane okane
```

另外兩條資料所有權路徑（在網站「設定 → 資料所有權」）：

- **匯出 JSON**：單一使用者的完整帳本，可在新環境「匯入完整備份」還原。
- 帳單原始檔（加密）在 `okane-data` volume；`pg_dump` 不含它們，要一起備就備 volume。

## 10. 升級

```bash
git pull
docker compose build
docker compose exec db pg_dump -U okane okane > pre-upgrade-$(date +%F).sql  # 先備份！
docker compose run --rm app migrate
docker compose up -d
```

app 啟動時會自己檢查有沒有漏跑的 migration，漏了會直接拒絕啟動並告訴你指令。

## 11. 疑難排解

| 症狀 | 檢查 |
|---|---|
| 開網頁一片空白／舊畫面 | PWA 有快取：重新整理兩次，或無痕視窗確認；升級後 Service Worker 會自動換新 |
| app 起不來說有 pending migration | 跑 `docker compose run --rm app migrate` |
| Interactions Endpoint 存不了 | 服務要先跑著、網域 HTTPS 要通、PUBLIC_KEY 要填對 |
| `/finance` 打了沒反應 | 指令註冊了嗎（6.4）？全域指令生效可等 1 小時 |
| bot 不私訊 | bot 跟你要共處一個伺服器；你的 Discord 隱私設定要允許伺服器成員私訊 |
| AI 測試連線失敗 | 端點要能從「使用者的伺服器」連到（自架 Ollama 在 localhost 時，指的是跑 okane 的那台機器） |
| 忘記密碼 | 有設 Passkey 或恢復碼就用它登入；管理者可在資料庫層處理（見 SECURITY.md） |

## 附錄：本機試玩（dev-lite，不用 Docker、不用 PostgreSQL）

只是想看看長什麼樣：

```bash
pnpm install
pnpm dev
```

開 `http://localhost:5173`。資料存在 `apps/api/.dev-data/`（內建 PGlite），啟動時會自動套用 migration，只供試玩；正式使用請走上面的 PostgreSQL 流程。

若只想以 production build 試跑單一 port，先執行 `pnpm --filter @okane-dokoitta/web build`，再執行 `pnpm --filter @okane-dokoitta/api dev:lite`，開 `http://localhost:3000`。
