# AGENTS.md — okane-dokoitta 開發守則

本文件是所有貢獻者（人類與 AI agent）的工作契約。開始任何工作前先讀完本文件，再依任務讀對應的 `docs/*.md`。

## 1. 專案是什麼

**okane-dokoitta**（お金どこいった？）是一套開源、免費、可自架的個人財務審計與資產中控台。

核心產品句：**錢花去哪，打開就知道**

主要能力：多帳戶與多信用卡記帳、信用卡帳單匯入與自動對帳、差額分析、投資與淨資產一覽、多裝置雲端同步（PWA）、Discord 通知與私密查詢。

第一位使用者是專案作者本人。第一版優先解決作者本人的完整工作流，不為想像中的其他使用者擴張功能。但產品是**多使用者**的（一個實例、多個使用者、各自獨立帳本）——任何設計不得假設「永遠只有一個使用者」；多使用者註冊與隔離驗證在 M2 落地。

## 2. 文件優先原則

- `docs/` 是規格的唯一真相來源。程式碼實作規格；當程式碼與文件衝突，以文件為準，或先修文件再改程式碼。
- 行為變更與文件更新必須在同一個 PR / commit 內完成。
- 架構層級的變更必須新增或修訂 `docs/DECISIONS.md` 的 ADR。
- 遇到規格未定的問題：分析方案 → 給推薦 → 寫入 `docs/OPEN_QUESTIONS.md` → 繼續工作。影響資料正確性、安全性或同步模型的選項必須標記「需要人工決策」，不得自行拍板。
- 禁止把未完成的能力寫進 `README.md` 或任何文件當成已完成。規格文件描述目標；README 的「現況」段落描述事實。

## 3. 不可違反的產品原則

1. **核心功能永久免費**：不得以帳戶數、卡片數、交易數、匯入次數、匯出能力或自架能力作為付費牆。
2. **資料所有權**：所有使用者資料（帳戶、交易、帳單、持倉、審計歷史、規則、別名、Discord 設定）必須可完整匯出為 JSON 與 CSV。不得建立只能匯入、無法匯出的封閉資料。
3. **優先級順序**：資料正確性 > 可追蹤性 > 安全性 > 同步穩定性 > 操作效率 > 視覺與動畫。低優先級不得犧牲高優先級。
4. **AI 只提案、不寫帳**：AI 與規則引擎只能產生 proposed patch，經使用者確認、domain service 驗證後才能寫入帳本，且必留 audit log。AI 不評分財務健康、不羞辱消費、不擅自給投資建議、不把推測描述成事實。
5. **語氣**：友善、柔和、可愛可以；金融菁英、財富自由話術、羞辱消費者的語言不行。帳務資料與操作本身必須專業、明確、可追蹤。

## 4. Repository 結構與責任邊界

pnpm workspace monorepo。目標結構（依里程碑逐步建立，**不要**預先建立空 package）：

```text
apps/
  web/             PWA 前端（React + Vite）
  api/             HTTP API（Hono on Node.js）
  discord/         Discord interactions endpoint 與通知發送
  worker/          排程與背景工作（帳單解析、提醒、備份）

packages/
  domain/          帳務核心：money、ledger、posting rules、狀態機（純 TS，無 IO）
  database/        Drizzle schema、migrations、repositories
  sync/            同步協議：mutation envelope、outbox、change feed
  audit-engine/    配對引擎與差額分析
  importers/       帳單匯入器（每個來源一個子目錄）
  investments/     持倉、價格與匯率計算
  notifications/   通知組裝、去重、冷卻（Web Push 與 Discord 的共用層）
  schemas/         Zod schemas 與 API contracts
  ui/              共用 UI 元件
  config/          共用 ESLint / TSConfig
```

依賴規則（違反即打回）：

- `packages/domain` 不依賴任何其他 workspace package，不做 IO，不 import UI、HTTP、Discord、資料庫。
- `packages/*` 不得 import `apps/*`。
- `apps/discord` 不得直接連資料庫；一律經過 `apps/api` 的正式 API 或共用 domain service。
- 所有帳本寫入必須經過 `packages/domain` 的 domain service；repository 層不得繞過驗證直接寫 `journal_lines`。
- `packages/schemas` 是 API contract 的唯一來源；client 與 server 共用同一份 Zod schema。

## 5. 硬規則（帳務、日期、識別碼）

### 金額

- 金額一律使用**整數最小貨幣單位**（`amountMinor`），DB 型別 `bigint`。
- **禁止**用浮點數儲存、運算或傳輸金額。禁止對金額使用 `parseFloat`、`toFixed` 運算鏈。
- 每個幣別的最小單位指數由 `packages/domain` 的 currency 表定義（TWD=0、JPY=0、USD=2）。顯示格式化只在 UI 層做。
- 所有除法（分期、匯率換算）必須經過 domain 的 money module，捨入規則集中定義，不得散落各處。

### 日期與時區

- `*_date` 欄位＝民用日期（無時區），格式 `YYYY-MM-DD`，以帳本時區解讀（預設 `Asia/Taipei`，使用者可設定）。帳單日、結帳日、繳款日都是民用日期。
- `*_at` 欄位＝時間點，UTC ISO 8601（DB `timestamptz`）。
- 兩者不得混用。不要用一個 `date` 欄位承擔多種時間意義；交易的完整日期欄位見 `docs/DATA_MODEL.md`。

### 識別碼與冪等

- 所有主鍵使用 UUIDv7，由 client 端產生（支援離線建立）。
- 所有 mutation 攜帶 client 產生的 `mutationId`（UUIDv7）作為冪等鍵；server 端重複收到同一 `mutationId` 必須回傳首次結果，不得重複套用。

### 帳務語意

- 內部採用複式帳本：每筆交易對應一個 `journal_entry`，其 `journal_lines` 必須平衡（見 `docs/DATA_MODEL.md`）。UI 不暴露借貸術語。
- **信用卡繳款是轉帳**（銀行資產減少、信用卡負債減少），不得再次計為支出。
- **投資買入是資產轉換**（交割現金減少、投資資產增加），不得計為消費；賣出不得計為一般收入。
- 退款必須連結原始交易，不得記成獨立收入。
- 刪除一律軟刪除（`deleted_at`），不得物理刪除帳務資料。
- 所有帳務資料的建立、修改、刪除都必須寫入 `audit_logs`（who / when / what / before / after / via）。沒有 audit log 的寫入路徑是 bug。

### AI 邊界

- AI 輸出只能成為 `proposed_patches` 的內容，狀態機為 `proposed → accepted/rejected → applied`。
- `applied` 只能由 domain service 在使用者確認後執行，並經過完整驗證與 audit log。
- AI 模組必須可選、可替換、可停用；核心功能在 AI 完全停用時仍需可用。

## 6. Migration 安全規則

- Migration 一律經 Drizzle 產生並 code review，不得手寫後直接套用到共用環境。
- 已套用（released）的 migration 檔案不得修改，只能追加新 migration。
- 破壞性變更（drop column/table、改型別縮小範圍）需要：作者明確核可 + 先備份 + 分兩階段（先停用、後刪除）。
- M0 階段禁止建立任何 migration。

## 7. 安全與 Secrets

- Secrets 只放環境變數，前綴 `OKANE_DOKOITTA_`，永不進 repository。提供 `.env.example`（只有 key，沒有值）。
- 所有資料查詢與寫入必須以 `user_id` 界定範圍——單人使用期間也一樣。任何無 `user_id` 界定的資料存取路徑是 bug；跨使用者資料外洩是安全事故。
- 永不儲存：網銀密碼、券商密碼、完整信用卡號（只能存末四碼）。
- Log 一律經過敏感欄位 redaction，不得輸出金額明細、token、session id 到一般 log。
- Discord 公開頻道不得輸出任何資產、餘額或交易資訊；只允許 DM 與 ephemeral response。
- 其餘安全需求見 `docs/SECURITY.md`，該文件的「最低安全需求」是驗收條件，不是建議。

## 8. 指令與開發流程

目前 repository 已進入 M1，開發流程：

```bash
pnpm install
pnpm dev          # 啟動本地開發（web + api）
pnpm test         # Vitest 單元與整合測試
pnpm typecheck    # tsc --noEmit，strict mode
pnpm lint
pnpm build
```

- TypeScript strict mode，不得關閉 `strict`、不得濫用 `any` 繞過型別。
- 本地環境用 Docker Compose 起 PostgreSQL（見 `docs/DEPLOYMENT.md`）。
- CI（GitHub Actions）必須跑 lint + typecheck + test；紅燈不得合併。

### UI 開發：Skill 套用與 UI library 規範

做 UI 工作時，依情境套用對應 skill，**一次只載入一個 concern 的 skill**，從任務實際所處的階段進入：

| 情境 | 套用 skill |
|---|---|
| 開新頁面、決定視覺方向（首頁資產一覽、對外頁面、品牌感頁面） | `ui-art-direction`（先定方向，避免模板感與企業 FinTech 感） |
| 表單、清單、dashboard、audit session UI 的資訊層級與行動層級 | `ui-complexity` |
| 既有 UI 的間距、字體、層級、responsive 打磨 | `ui-refactoring` |
| 對外／品牌相關頁面完成後的除 AI 味與執行品質 | `taste-frontend` |
| 流程、表單、錯誤訊息、設定、onboarding 的互動設計 | `user-experience` |
| 動畫、轉場、micro-interaction | `motion-design`（實作視需要配 `gsap-*`） |
| 圖表與資料視覺化（資產趨勢、現金流、審計統計） | `dataviz` |
| 一般 coding 風險護欄 | `careful-coding` |

UI library 規則：

- 元件採 **shadcn/ui 模式**（Radix primitives + Tailwind，元件原始碼複製進 `packages/ui`）。理由：元件程式碼在自己 repo 內、無 runtime 版本耦合、可完全改造成本產品的視覺語言。
- 可接受的依賴：Radix primitives、Tailwind CSS 等 headless / utility 層。**不引入** MUI、Ant Design 等自帶強烈視覺語言的重耦合元件框架。
- shadcn 預設外觀是通用模板感——品牌相關頁面不得直接出貨預設主題，必須先經 `ui-art-direction` 定調後改造。
- 自訂 CSS class 前綴用 `odk-`。

## 9. 測試層級與完成定義

測試層級（詳見 `docs/TESTING.md`）：

1. **Domain 單元測試**：money 運算、posting rules、狀態機、matching 規則——最高優先，覆蓋所有帳務不變量。
2. **Importer fixture 測試**：每個 importer 附去識別化樣本檔與預期輸出。
3. **API 整合測試**：對真實 PostgreSQL 跑，涵蓋冪等與衝突案例。
4. **E2E（Playwright）**：關鍵流程，含離線→同步。

**完成定義（Definition of Done）**——一個任務要同時滿足：

- 程式碼合乎本文件所有硬規則
- 對應層級的測試存在且通過（帳務邏輯必附測試）
- 實際執行過驗證（測試輸出、指令結果），不得以「我寫對了」代替驗證
- 相關文件已更新
- 有 schema 變更時，migration 已 review
- 回報中明確列出：改了什麼、跑了什麼驗證、結果、剩餘風險

## 10. Agent 行為限制

- **回應一律使用中文**（繁體）。聊天回報、計畫說明、HANDOFF.md 皆用中文；程式碼、識別碼、commit 訊息的技術術語可保留英文。
- Agent 為驗證而啟動的本機伺服器、watcher 或背景程序，除非使用者明確要求保持運行，必須在回報完成前關閉，並實際確認相關 port／process 已停止；不得把「已驗證」等同於「可以留著跑」。
- 每次 coding task 結束前，必須新增或更新根目錄 `HANDOFF.md`，至少記錄目前狀態、已完成範圍、實際執行的驗證與結果、未驗證／失敗事項、剩餘風險與下一個可執行步驟；不得只在聊天中回報。除非使用者明確要求不納入版本控制，`HANDOFF.md` 必須與該次變更一同提交。
- **禁止自行擴張功能**。規格外的想法寫進 `docs/OPEN_QUESTIONS.md` 作為選項，不要實作。
- 不假設這是面向企業、富裕投資人或理財顧問的產品。
- 同一子任務失敗兩次：停止重試，回報失敗過程。
- 大量檔案掃描、批次修改、網路研究交給 subagent；主對話只收結論與 `file:line` 引用。
- 不確定規格時，先查 `docs/`；`docs/` 沒有答案時依第 2 節的未定事項流程處理。

## 11. 品牌規範（摘要）

- 正式名稱固定寫作 `okane-dokoitta`：全小寫、兩個連字號。不使用 `OkaneDokoitta`、`Okane Dokoitta`、`ODK`。
- 日文 `お金どこいった？` 可作標題副文字或介面彩蛋；中文說明不得取代正式名稱。
- 識別形式：npm scope `@okane-dokoitta/*`、env 前綴 `OKANE_DOKOITTA_`、DB schema `okane_dokoitta`、CSS 前綴 `odk-`（僅內部使用）、internal slug `okane-dokoitta`。
- 禁止在任何文件或程式碼中使用 `PetalLedger`、`finance-app`、`personal-finance-app` 等暫定名稱。
- 文案語氣規範見 `docs/PRODUCT_VISION.md`。
