# ARCHITECTURE — 系統架構與技術選型

相關 ADR：ADR-002（同步）、ADR-004（部署）、ADR-005（Discord）、ADR-007（Importer）。

## 1. 系統全貌

```text
Cloudflare Worker（Wrangler 部署）
├─ React + Vite PWA / Static Assets
├─ Hono API
├─ 驗證與同步端點
├─ Discord Slash Commands（M5，HTTP interactions）
├─ Cron / Queues / Workflows（有對應工作時才綁定）
├─ R2（加密帳單檔；雲端備份待落地）
└─ Hyperdrive
     ↓
PostgreSQL
└─ Managed Postgres 或獨立 VPS

需要時才加入 Node.js 重型處理 worker
├─ PDF 解析
├─ OCR
├─ 大型匯入
└─ 本地 AI
```

- **Server-authoritative**：PostgreSQL 是唯一真相；PWA 持有 IndexedDB 鏡像與離線 outbox（ADR-002，細節見 `docs/SYNC_DESIGN.md`）。
- **Wrangler 是部署 SSOT**：`wrangler.jsonc` 綁定 Static Assets、Hyperdrive、R2 與 Cron；正式資源 ID 與 secrets 由架設者提供。
- **Node 是例外，不是第二套預設後端**：只把確定超出 Workers 限制的重工作交給 Node，帳務與驗證仍走正式 Hono API／domain service。
- **Discord 無長連線**：HTTP interactions endpoint 收指令、REST API 發 DM（ADR-005）。

## 2. Monorepo 結構與依賴方向

pnpm workspace；package 責任見 `AGENTS.md` 第 4 節。依賴方向（只能往下依賴）：

```text
apps/web  apps/api  apps/discord  apps/worker
    │         │          │            │
    └─────────┴────┬─────┴────────────┘
                   ▼
  packages/schemas  packages/ui (僅 web)
                   ▼
  packages/sync  packages/audit-engine  packages/importers
  packages/investments  packages/notifications  packages/database
                   ▼
            packages/domain        （純 TS，無 IO，不依賴任何人）
```

關鍵邊界：

- `domain` 定義 money、posting rules、狀態機、驗證——所有帳本寫入的必經之路。
- `database` 是唯一碰 SQL 的 package；repositories 接受/回傳 domain 型別。
- `schemas`（Zod）是 API contract 唯一來源，client/server 共用，杜絕前後端 drift。
- `apps/discord` 只呼叫 api 層服務，不 import `database`。

## 3. 技術選型

| 層 | 選擇 | 理由 |
|---|---|---|
| 語言 | TypeScript strict | 作者熟悉；全棧共用型別 |
| Monorepo | pnpm workspace | 標準、快、無額外工具 |
| 前端 | React + Vite + vite-plugin-pwa | 生態成熟；PWA plugin 處理 SW/manifest |
| UI 元件 | **shadcn/ui 模式**：Radix primitives + Tailwind，元件原始碼 vendored 進 `packages/ui` | 元件在自己 repo 內＝零 runtime 耦合、可整套改造成品牌視覺；headless 邏輯 + 自有樣式。不用 MUI/AntD（重耦合、企業視覺語言） |
| 本地儲存 | 原生 IndexedDB | M2 目前只需固定 stores；避免為薄封裝新增 runtime 依賴，並以 `user_id` 分庫 |
| HTTP | Hono | 輕量、runtime-portable（未來要上 Workers 不必重寫路由層） |
| Runtime | Cloudflare Workers + `nodejs_compat` | Hono、`pg`、Drizzle 與現有 Node crypto 路徑可共用；重工作按需拆出（ADR-004） |
| DB | PostgreSQL 16 | 交易性、成熟、自架容易 |
| ORM | Drizzle | 型別安全、migration 可控、無魔法 |
| 驗證 | Zod | schemas package 的基礎 |
| Discord | interactions HTTP endpoint + REST（不用 discord.js gateway） | 無常駐連線（ADR-005） |
| 測試 | Vitest + Playwright | 見 `docs/TESTING.md` |
| 部署 | Wrangler + Workers Static Assets | 同一個部署包含 React build 與 Hono Worker |
| DB 連線 | Hyperdrive + `pg` | PostgreSQL 可在 managed service 或 VPS |
| 檔案 | R2 binding | 帳單原始檔仍先做應用層 AES-256-GCM 加密 |
| CI | GitHub Actions | lint + typecheck + test |

暫不引入：狀態管理框架（先用 React 內建 + Dexie live queries，不夠再說）、tRPC（Zod contract + Hono client 已涵蓋）、Redis（單人負載用不到，排程狀態放 Postgres）。

### UI 開發流程

UI 工作依情境套用 skill（`ui-art-direction` → `ui-complexity` → `ui-refactoring` → `taste-frontend` 等），對照表與 UI library 詳細規則見 `AGENTS.md` 第 8 節「UI 開發」。

## 4. Cloudflare runtime 邊界

- React build 由 Workers Static Assets 供應；`/api/*` 才先進 Worker。
- Hono API 每次 request 透過 Hyperdrive 連 PostgreSQL，所有資料查詢仍以 `user_id` 界定。
- R2 只存加密 envelope，不存可讀帳單原文。
- Cron 目前只執行原始檔保留期清理。
- Queues、Workflows、Discord bindings 尚未有對應功能，不在設定檔放空 handler；到 M5/M6 落地時再加入。
- `apps/api/src/server.ts` 與 dev-lite 保留給本地開發及 Node 替代部署，不是正式 Cloudflare 入口。

## 5. 背景工作

任務狀態存 PostgreSQL `jobs` 表；執行工具按工作重量選：

- **Cron**：固定時間掃描，例如原始檔保留期、提醒與備份排程。
- **Queues**：匯入、通知等可重試的短工作；功能落地才加入 consumer。
- **Workflows**：有多步驟、等待或人工確認的長流程才使用。
- **Node 重型 worker**：PDF/OCR、大型匯入、本地 AI；不讓這些工作改變核心 API runtime。

## 6. 檔案儲存

Cloudflare 部署將帳單檔加密後寫入 R2，DB 只記 metadata 與生命週期（見 `docs/SECURITY.md` 第 6 節）。Node／dev-lite 仍用本機 data directory；兩條路徑寫入同一種加密 envelope。

## 7. 未來原生客戶端的不封死條款

- 所有功能經 HTTP API + Zod contract 提供，PWA 沒有私有後門 API。
- 同步協議（`docs/SYNC_DESIGN.md`）與 UI 無關，任何 client 實作 outbox + change feed 即可接入。
- `packages/domain` 純 TS，可被未來的 React Native / Tauri client 直接重用。
