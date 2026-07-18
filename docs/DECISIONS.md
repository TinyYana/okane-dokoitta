# DECISIONS — 架構決策紀錄（ADR）

格式：狀態 / 背景 / 考慮方案 / 決策 / 理由 / 代價 / 重新評估時機。

狀態定義：

- `accepted`：已採納，實作依此進行。
- `proposed`：M0 推薦方案，**待作者確認**後才升級為 accepted。
- `superseded`：被後續 ADR 取代。

---

## ADR-001：帳務模型 — 複式帳本核心 + 交易外觀層

**狀態**：accepted

**背景**：系統要同時正確處理支出、收入、轉帳、信用卡消費與繳款、退款、投資買賣、股息、手續費與匯率。單式記帳（一筆交易一個金額一個帳戶）無法保證「信用卡繳款不重複算支出」「投資買入不算消費」這類不變量。

**考慮方案**：

1. 單式記帳 + 特例規則：每種特殊交易寫 if/else。簡單起步，但特例會隨功能增長失控，對帳時無法驗證帳本自身平衡。
2. 完整複式帳本，UI 也用借貸術語：正確但對一般使用者不友善，違反產品語氣。
3. **複式帳本核心 + 交易外觀層**：內部每筆交易由 domain service 依 posting rules 產生平衡的 `journal_entry`（2+ 條 `journal_lines`）；使用者只看到「支出／收入／轉帳／繳款／買入」等交易類型。

**決策**：方案 3。

**理由**：複式帳本讓「每個 entry 的 lines 總和為零」成為可機器驗證的不變量；審計引擎能直接檢查帳本自身是否平衡。外觀層維持產品語氣。分類（餐飲、交通…）內部建模為 expense/income 帳戶，天然納入平衡檢查。

**代價**：domain layer 較厚；每種交易類型都要定義 posting rule；轉帳、多幣別需要明確規則（見 `docs/DATA_MODEL.md`）。

**重新評估時機**：若 posting rules 數量失控（>20 種且持續增長），檢討外觀層抽象是否漏了通用形狀。

---

## ADR-002：同步架構 — Server-authoritative + IndexedDB mirror + mutation outbox

**狀態**：accepted

**背景**：多裝置同步是硬需求；財務資料的衝突必須被看見並由使用者解決，不能靜默合併。

**考慮方案**：詳細比較見 `docs/SYNC_DESIGN.md` 第 2 節。摘要：

1. **Server-authoritative PostgreSQL + IndexedDB mirror + outbox**：server 是唯一真相；client 快取 + 離線佇列；樂觀版本檢查偵測衝突。
2. 完整 local-first event log（event sourcing）：所有裝置重放事件流。可離線性最強，但實作與除錯成本高，事件 schema 演進痛苦。
3. CRDT：自動合併。對文字協作合理；對帳務資料是錯誤語意——兩台裝置同時把同一筆交易改成不同金額時，自動合併等於捏造帳務事實。
4. 僅線上 SaaS：無離線，違反硬需求。

**決策**：方案 1。

**理由**：帳務資料的正確語意是「衝突要浮上來給人看」，樂觀鎖 + 衝突佇列正是這個語意。PostgreSQL 交易性保證 server 端一致性；audit log 與 sync mutation log 提供可追蹤性，涵蓋了 event sourcing 的主要好處而沒有其複雜度。單人多裝置的寫入頻率極低，不需要 CRDT 級的合併能力。

**代價**：離線期間其他裝置看不到新資料（可接受）；需要自行實作 outbox、change feed、衝突 UI；server 停機時只能讀快取與排隊寫入。

**重新評估時機**：若未來要支援多人共用帳本的高頻並行編輯，重新檢視。

---

## ADR-003：資料加密 — 混合式（傳輸 + 靜態加密 + 選擇性應用層加密），不採完整 E2EE

**狀態**：accepted（2026-07-17 作者核可。驗收基準：使用者之間互不可見＋整體低外洩風險；不要求 E2EE）

**背景**：這是個人財務系統，隱私敏感；但核心功能（伺服器排程提醒、Discord 通知、伺服器端帳單解析與配對）都需要伺服器讀懂金額與日期。作者已確認（2026-07-17）：**實例會供多位使用者同時使用**（各自獨立帳本）——因此「server 管理者＝使用者本人」的假設只在單人自架成立，多使用者實例下管理者可以不是資料擁有者。

**考慮方案**：完整比較見 `docs/SECURITY.md` 第 3 節。摘要：

1. 僅 TLS + DB/磁碟靜態加密
2. 應用層欄位加密（server 持有金鑰）
3. 使用者主密鑰加密（server 無法解密指定欄位）
4. 完整 E2EE
5. 混合式：TLS + 靜態加密 + 應用層加密敏感附件與 token；金額、日期、帳戶結構對 server 可見

**決策（推薦）**：方案 5 為基線。完整 E2EE 與「伺服器端排程通知、Discord 提醒、伺服器端解析」直接衝突——server 看不到金額與日期就無法算「扣款帳戶餘額不足」或「帳單即將到期」。

多使用者的補充決策：

- **使用者之間**的隔離是硬需求：所有查詢以 `user_id` 界定（AGENTS §7）、跨使用者 IDOR 整合測試（M2）、per-user rate limit。這一層沒有取捨空間。
- **管理者對使用者**：方案 5 下，實例管理者理論上可讀使用者的帳務欄位——這是為保住自動化能力的已知取捨，必須寫進自架文件讓使用者知情。作者核可此取捨。使用者主密鑰加密（方案 3）列為**未來可選強化（非承諾項）**，若做則優先套用於備註與帳單原始檔等非自動化必要欄位。

**理由**：優先保住自動化能力；用靜態加密 + 嚴格授權隔離 + audit log 保護資料。上傳的帳單原始檔、Discord bot token、OAuth token 以應用層加密儲存。

**代價**：多使用者實例的管理者可讀帳務欄位（知情揭露 + 未來 opt-in 主密鑰加密緩解）；官方託管（未來）同樣適用此取捨。

**重新評估時機**：官方雲端託管服務啟動前必須重新評估（方案 3 屆時從可選強化升級為重點評估項）。

---

## ADR-004：部署平台 — Cloudflare Workers + Hyperdrive PostgreSQL，Node 重型 worker 按需加入

**狀態**：accepted（2026-07-18 supersede 原 Node 單體決策）

**背景**：正式部署由 Wrangler 管理。主要流量是 PWA 靜態資源、Hono API、同步、Discord interactions 與短背景任務；PDF/OCR、大型匯入與本地 AI 不應拖著整套服務留在常駐 Node 容器。

**考慮方案**：

1. Node.js 單體 + PostgreSQL：本機與 VPS 簡單，但靜態資源、HTTP、排程、檔案儲存都要自行維運。
2. **Cloudflare Workers + Hyperdrive + R2**：React 靜態資源與 Hono API 同一個 Worker 專案；Cron／Queues／Workflows 只在對應功能出現時加入；PostgreSQL 可用 managed service 或獨立 VPS。
3. 全部工作都塞進 Workers：PDF/OCR 與本地 AI 受 CPU、記憶體與 runtime 限制，不採用。

**決策**：方案 2。Wrangler 是正式部署 SSOT。Workers 負責 PWA、Hono API、驗證與同步端點、Discord HTTP interactions、短排程與事件協調；R2 保存加密帳單檔與雲端備份；Hyperdrive 連 PostgreSQL。只有 PDF 解析、OCR、大型匯入或本地 AI 真正超出 Workers 限制時，才加入 Node.js 重型處理 worker。

**理由**：讓日常路徑維持單一 TypeScript/Hono runtime，部署、TLS、靜態資源與短排程由 Cloudflare 處理；資料仍在使用者自己的 PostgreSQL，Node 只為確定需要的重工作存在。

**代價**：正式部署依賴 Cloudflare；Hyperdrive、R2 與 Worker bindings 需要一次性建立。VPS/Docker Node server 保留為替代執行方式，但不享有 Cloudflare Cron、Queues、Workflows 與 R2 的同形部署。

**重新評估時機**：任何工作在實際 Worker limits 下無法穩定完成，才把該工作移到 Node 重型 worker，不移動整個 API。

---

## ADR-005：Discord Bot 架構 — HTTP interactions endpoint，不用 gateway 長連線

**狀態**：accepted

**背景**：Discord 支援兩種模式：gateway WebSocket 長連線（discord.js 傳統模式）與 HTTP interactions endpoint（Discord 主動 POST 到你的 URL）。

**考慮方案**：

1. discord.js gateway：功能全（可讀訊息事件），但需要常駐長連線、斷線重連管理，自架多一個易碎的常駐元件。
2. **HTTP interactions endpoint**：Slash commands 與按鈕互動經 HTTPS POST 進來；主動通知用 Discord REST API 發 DM。無長連線。

**決策**：方案 2。`apps/discord` 是一個 HTTP endpoint（掛在 api 同一個 server 上）+ 透過 REST API 發送通知的 client。

**理由**：本產品只需要 slash commands、按鈕確認與主動 DM 通知，全部不需要 gateway。少一個常駐連線＝自架穩定性高一級。所有指令經正式 API 與 domain service，bot 不直接碰資料庫。

**代價**：無法監聽頻道訊息事件（本來就不該做）；需要公開 HTTPS URL（自架本來就有）。

**重新評估時機**：若未來需要語音或訊息事件功能（目前無此規劃）。

---

## ADR-006：AI 邊界 — proposal-only，經 proposed_patches 與人工確認

**狀態**：accepted

**背景**：AI 可大幅降低帳單解析與配對的人工成本，但 LLM 輸出不可靠，不能直接寫入帳本。

**考慮方案**：

1. AI 直接寫入，事後可 undo：不可接受——帳本會短暫存在錯誤事實，且 undo 依賴使用者發現。
2. **AI 只產生 proposed patch**：`AI/規則 → proposed_patches → 使用者確認 → domain service 驗證 → 寫入 → audit log`。
3. 完全不用 AI：喪失髒資料處理能力。

**決策**：方案 2，且 rule-based engine 是主要真相來源，AI 是排序與解釋的輔助層。AI 模組可選、可替換、可停用（BYOK；未設定 API key 時所有核心功能照常運作）。

**理由**：見 `AGENTS.md` 第 5 節與 `docs/AUDIT_ENGINE.md`。每個候選必附 score、evidence、reasoning codes、人類可讀解釋與 proposed patch——不允許只回一個模糊信心值。

**代價**：多一層確認流程；使用者要點確認——這是特性不是缺陷。

**重新評估時機**：不重新評估「AI 不直接寫帳」本身；只重新評估 AI 可參與的環節範圍。

---

## ADR-007：Importer 插件系統 — in-repo package + 統一 normalized format

**狀態**：accepted

**背景**：帳單來源多樣（CSV、PDF、貼上文字、MOZE 匯出…），且會持續增加新銀行。

**考慮方案**：

1. 單一巨型 parser + if/else 判斷來源：不可擴充。
2. **in-repo 插件**：`packages/importers/` 下每來源一個子目錄，實作同一個 `Importer` interface，輸出統一 `NormalizedStatement`；用 registry 註冊，靠 `detect()` 自動辨識來源。
3. 動態載入外部插件（npm 安裝第三方 importer）：安全風險（解析器碰的是財務資料）且 M0 不需要。

**決策**：方案 2。介面與格式定義見 `docs/IMPORTER_SYSTEM.md`。第三方動態插件延後。

**理由**：in-repo 插件保有型別安全與 code review，每個 importer 附 fixture 測試。統一格式讓審計引擎與 importer 完全解耦。

**代價**：新增銀行要發 PR（可接受，通用 CSV/文字 importer 可先頂著用）。

**重新評估時機**：出現大量社群貢獻需求時，評估插件簽章與 sandbox。

---

## ADR-008：投資價格來源 — 交易所／報價 provider 自動抓取，不讓使用者手抄價格

**狀態**：accepted（2026-07-18 作者以實際 VT 使用否決原「手動維護」決策）

**背景**：投資一覽需要目前價格與匯率。原決策要求使用者手動輸入價格；實際登記美元 ETF `VT` 後，這不但負擔高，也容易把美元價格誤當新臺幣，不能作為可用流程。

**考慮方案**：

1. Yahoo Finance 等非官方端點：免 key，但穩定性與授權邊界不清楚。
2. 單一商業行情 API 包辦所有市場：介接簡單，但把核心估值綁在單一付費服務。
3. **依市場選 provider**：臺灣上市證券用臺灣證券交易所 OpenAPI；美股／美國 ETF 用 Finnhub Quote API，token 由架設者提供；保存 `as_of` 與 `source`。
4. 爬取券商／交易所網頁：未授權且易碎，明確排除。

**決策**：方案 3。投資頁只提供「取得／自動更新報價」，不提供手動輸入價格。`TW/TWD` 走 TWSE、`US/USD`（含 `VT`）走 Finnhub。Finnhub token 只存在伺服器環境變數 `OKANE_DOKOITTA_FINNHUB_TOKEN`，不送到瀏覽器；未設定時回傳可操作錯誤，台股與核心帳務仍可用。現階段是使用者觸發的單次更新，不做高頻輪詢或即時推播。

**理由**：官方交易所來源優先；美股以有正式 Quote API 與 token 驗證的 provider 補足。使用者不再抄數字，價格仍以 append-only 快照保存並留下 audit log，可追蹤來源與時間。這同時避開未授權爬取與把免費核心綁死在付費行情代理。

**代價**：美股需要架設者申請 Finnhub token；provider 故障、限流或找不到代號時無法更新，系統會保留上一筆價格並顯示錯誤。上櫃、其他國家市場與自動匯率尚未涵蓋。

**重新評估時機**：需要上櫃／其他市場、Finnhub 使用條款或可用性不再合適、或匯率手動維護成為實際負擔時，再增加 provider；不得退回要求使用者手抄報價。

---

## ADR-009：自架註冊政策 — 架設者設定 open／invite／closed

**狀態**：accepted（2026-07-17 作者確認：公開專案不能把單一站台政策寫死）

**背景**：同一份開源程式可被用在個人、親友共享或公開社群實例。固定開放註冊會增加濫用面；固定關閉或邀請制則限制架設者的自主權。

**考慮方案**：只做邀請制；只做公開註冊；由架設者用環境變數選擇策略。

**決策**：`OKANE_DOKOITTA_REGISTRATION_MODE=open|invite|closed`，預設 `invite`。first-run setup 永遠可建立第一位管理者；邀請碼只儲存 HMAC、一次性使用並可撤銷。管理者 UI 可建立邀請碼與查看實例帳號，但不能藉此讀取其他使用者帳本。

**理由**：政策屬於自架營運者的部署選擇，不是財務 domain 規則；安全預設仍採邀請制。

**代價**：文件與測試必須覆蓋三種策略；公開註冊實例的濫用防護由 rate limit 與架設者部署邊界共同承擔。

**重新評估時機**：需要 Email 驗證、停權或大規模公開實例治理時。

---

## ADR-010：多卡合併帳單 — 銀行帳單群組 + 每卡獨立審計

**狀態**：accepted（2026-07-18 作者確認）

**背景**：聯邦銀行同一份 CSV 同時包含多張卡，銀行只聲稱一個合併應繳總額；既有 `statements` 則是一張卡一份，不能任選一張卡承接整份檔案，也不能把自行加總的每卡小計冒充銀行帳單總額。

**決策**：新增 `statement_groups` 保存原始檔、銀行、帳單期間、繳款日與銀行合併應繳；每張卡仍各建一個 `statement`、`statement_items` 與 `audit_session`。子 statement 的 `total_minor` 是該卡明細小計，不要求其合計等於 group 總額，因外部帳單可能含前期餘額或付款調整。歷史 UI 以銀行 group 為第一層，卡片審計為第二層。

**理由**：同時保留銀行外部事實與逐卡審計邊界，原始檔只加密保存一次，且不破壞既有單卡 statement。

**代價**：新增 additive migration、group/child 查詢與匯出還原順序；付款歸屬 group 的進一步自動化仍需另外設計。

**重新評估時機**：銀行提供可獨立驗證的每卡應繳，或需要把一次繳款自動分攤到 group 下多卡時。
