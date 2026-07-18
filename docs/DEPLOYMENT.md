# DEPLOYMENT — Cloudflare 與自架

> 第一次架設？先看手把手教學 `docs/SETUP_TUTORIAL.md`（Docker Compose 路線＋Discord bot 申請全流程）。本文件是給已熟悉部署的人的精簡參考。

相關 ADR：ADR-004。正式部署以 **Cloudflare Workers + Wrangler** 為主，PostgreSQL 可以放在 managed service 或自己的 VPS。Node.js 服務保留給本地開發，以及 Workers 不適合處理的重工作。

## 1. 正式拓撲

```text
Cloudflare Worker
├─ React + Vite PWA / Static Assets
├─ Hono API
├─ 驗證與同步端點
├─ Discord Slash Commands（M5）
├─ Cron / Queues / Workflows（有工作時才加入）
├─ R2（加密帳單檔與日後備份）
└─ Hyperdrive
     ↓
PostgreSQL
└─ Managed Postgres 或獨立 VPS

需要時才加入 Node.js 重型 worker
├─ PDF 解析
├─ OCR
├─ 大型匯入
└─ 本地 AI
```

`wrangler.jsonc` 是 Cloudflare 綁定的唯一設定來源。現階段已設定 Static Assets、Hyperdrive、R2 與保留期清理 Cron；Queues、Workflows、Discord 等到真正有 consumer 或 handler 時再加入。

## 2. 第一次設定 Cloudflare

先建立 R2 bucket，再用正式 PostgreSQL 連線建立 Hyperdrive。密碼不要直接留在 shell history；依 Cloudflare 提示用安全方式提供連線資訊。

```bash
pnpm install
pnpm exec wrangler r2 bucket create okane-dokoitta-imports
pnpm exec wrangler hyperdrive create okane-dokoitta-db --connection-string="<PostgreSQL connection string>"
```

把建立完成的 Hyperdrive ID 填進 `wrangler.jsonc`，再設定 secrets：

```bash
pnpm exec wrangler secret put OKANE_DOKOITTA_SESSION_SECRET
pnpm exec wrangler secret put OKANE_DOKOITTA_FILE_KEY
```

M5 功能選填，作者準備好才設定（Q10：先在 Discord Developer Portal 建立 application）：

```bash
pnpm exec wrangler secret put OKANE_DOKOITTA_DISCORD_APP_ID
pnpm exec wrangler secret put OKANE_DOKOITTA_DISCORD_PUBLIC_KEY
pnpm exec wrangler secret put OKANE_DOKOITTA_DISCORD_BOT_TOKEN
pnpm exec wrangler secret put OKANE_DOKOITTA_DISCORD_CLIENT_SECRET
pnpm exec wrangler secret put OKANE_DOKOITTA_VAPID_PUBLIC_KEY
pnpm exec wrangler secret put OKANE_DOKOITTA_VAPID_PRIVATE_KEY
pnpm exec wrangler secret put OKANE_DOKOITTA_VAPID_CONTACT_EMAIL
```

正式發布：

```bash
pnpm deploy:cloudflare
```

這個指令會先跑 monorepo production build，再交給 Wrangler 發布。部署是外部狀態變更，執行前要確認目標 Cloudflare 帳號與環境。

## 3. 環境變數與 secrets

| 變數 | Wrangler 類型 | 用途 |
|---|---|---|
| `OKANE_DOKOITTA_SESSION_SECRET` | secret | session 簽章，至少 32 bytes |
| `OKANE_DOKOITTA_FILE_KEY` | secret | R2 帳單檔的應用層加密金鑰 |
| `OKANE_DOKOITTA_REGISTRATION_MODE` | var | `open`／`invite`／`closed`，預設 `invite` |
| `OKANE_DOKOITTA_IMPORT_RETENTION_DAYS` | var | 匯入原始檔保留天數，預設 90 |
| `OKANE_DOKOITTA_TZ` | var | 帳本預設時區，預設 `Asia/Taipei` |
| `OKANE_DOKOITTA_FINNHUB_TOKEN` | secret | 美股／美國 ETF 自動報價；選填，未設定時台股 TWSE 報價仍可用 |
| `OKANE_DOKOITTA_DISCORD_APP_ID` / `_DISCORD_PUBLIC_KEY` / `_DISCORD_BOT_TOKEN` / `_DISCORD_CLIENT_SECRET` | secret | M5 Discord，四個都要設定才啟用；缺任一個相關路由回報未設定 |
| `OKANE_DOKOITTA_VAPID_PUBLIC_KEY` / `_VAPID_PRIVATE_KEY` / `_VAPID_CONTACT_EMAIL` | secret | M5 Web Push；contact email 是 VAPID JWT 的 `mailto:` subject（RFC 8292 必填） |

本地 Node 模式另外使用 `OKANE_DOKOITTA_DATABASE_URL` 與 `OKANE_DOKOITTA_DATA_DIR`。Cloudflare Worker 從 `HYPERDRIVE.connectionString` 取得資料庫連線，不把 DB 密碼寫進 repository。

## 4. Migration 與升級

- Migration 仍由 Drizzle 產生並人工執行，不在 Worker 啟動時自動套用
- `OKANE_DOKOITTA_MIGRATE_DATABASE_URL` 只交給 migration 指令，不放進 Worker runtime
- released migration 不修改；破壞性變更依 `AGENTS.md` §6 分兩階段處理
- 發布前先完成資料庫備份，發布後檢查 Worker、Hyperdrive 與 R2 綁定

## 5. 備份與還原

- PostgreSQL 備份使用 `pg_dump`
- 帳單原始檔在寫入 R2 前先以 AES-256-GCM 加密
- R2 備份工作尚未落地；目前不可把「有 R2」寫成「已完成異地備份」
- 應用層 JSON/CSV 匯出與災難備份是兩件事，兩者都要保留

```bash
pnpm backup -- ./okane-2026-07-18.odkbak
pnpm restore -- ./okane-2026-07-18.odkbak --confirm-restore
```

還原會覆寫目標資料，只能對已確認的新實例或復原環境執行。

## 6. 本地開發

有 Docker 時使用 PostgreSQL：

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm install
pnpm --filter @okane-dokoitta/database migrate
pnpm --filter @okane-dokoitta/api dev:postgres
pnpm --filter @okane-dokoitta/web dev
```

沒有 Docker 時，repository 的預設 `pnpm dev` 會同時啟動 PGlite API 與 Vite。PGlite 資料放在 `apps/api/.dev-data/`，啟動時自動套用 migration；只供開發，不是正式部署方式。

```bash
pnpm --filter @okane-dokoitta/web build
pnpm --filter @okane-dokoitta/api dev:lite
```

要在本地使用 Cloudflare runtime：

```bash
pnpm dev:cloudflare
```

本地 secrets 放 `.dev.vars`，這個檔案被 git 忽略。可從 `.dev.vars.example` 複製 key，再自行填值。

## 7. Node.js 替代部署

`apps/api/src/server.ts` 仍可讓完全不使用 Cloudflare 的自架者在 Node.js 上啟動 Hono API。PDF、OCR、大型匯入與本地 AI 也走獨立 Node worker；它們不得繞過正式 API、domain service 或 audit log。
