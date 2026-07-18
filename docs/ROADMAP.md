# ROADMAP — 里程碑與範圍

原始提案的 Roadmap 經重新評估，主要調整見 §1。**MVP = M1–M3 完成**：作者可完成「記帳 → 同步 → 匯入帳單 → 審計」完整月循環。

## 1. 對原始提案的調整（附理由）

1. **M1 從第一天就有 server + PostgreSQL（單裝置、線上）**。原案 M1 純本地、M2 才加 server——但同步模型是 server-authoritative（ADR-002），先做純本地儲存層再搬到 server 是整層丟掉重寫；且複式帳本的驗證本來就在 domain/service 層，需要 server 形狀。M1 的 PWA 直接打 API，離線能力與多裝置留到 M2。
2. **完整 JSON 匯出提前到 M1**（原案 M2）。資料所有權是根本原則，從第一筆真實資料起就要能帶走。
3. **冪等 mutation、軟刪除、audit log 從 M1 開始**（原案 M2 才有 audit log）。這三者是 schema 形狀，事後補是痛苦 migration；且 M2 的同步協議直接建立在 M1 的 mutation 形狀上。
4. 其餘 M3–M6 順序維持原案；各里程碑內容微調如下。

## 2. 里程碑

> 2026-07-18 實作註記：M1–M5 的程式路徑已落地；五個里程碑的真實使用退出條件尚未完成，因此狀態不是「實測結案」。聯邦銀行 CSV 已完成真實格式解析，並以 ADR-010 的銀行帳單群組落地多卡寫入；仍待作者用原檔完成實際匯入驗收。MOZE、國泰與 LINE Bank importer 仍受 Q8/Q9 樣本阻塞。M4 已區分期初持倉（不扣交割現金）與真正買入，標的可編輯，台股／美股報價改由 TWSE／Finnhub 自動抓取。M5 Discord bot 需要作者提供 Q10 的 application 憑證才能實際連線測試。

### M0：規格與架構 ✅（本階段）

所有 `docs/` 文件、AGENTS.md、8 個 ADR、MVP 範圍界定。**不含任何功能實作。**

### M1：帳本核心（可每天記帳）

- pnpm workspace 骨架、CI、Docker Compose（postgres）
- `domain`：money、accounts、posting rules、狀態機（L1 測試齊）
- `database`：核心表 + 最簡 auth（單使用者、密碼登入；Passkey 在 M2）
- `api`：帳戶/交易/轉帳/退款 CRUD（冪等 mutation 形狀、audit log、軟刪除）
- 信用卡：卡片、共用額度群組、週期視圖、繳款（轉帳語意）
- 週期規則 + 預計交易（手動確認）
- PWA：安裝性、深淺色、快速記帳（F1）、完整 JSON/CSV 匯出
- **退出條件**：作者用它記帳一週，餘額與卡週期正確

### M2：雲同步（多裝置可用）

- `sync`：outbox、change feed、版本衝突、衝突 UI（F2）
- IndexedDB 鏡像（原生 API，沒有為薄封裝額外引入 Dexie）、離線記帳、同步狀態顯示
- Passkey + recovery codes、session/裝置管理與撤銷（F9）
- 多使用者：註冊（或邀請制）、使用者管理、跨使用者 IDOR 整合測試（SEC-6）
- 備份加密 + 還原（F10）、還原演練入 release 流程
- **退出條件**：iPhone + Windows 同時使用一週，零靜默覆寫；第二個使用者帳號與作者並用，資料完全隔離

### M3：帳單審計（產品核心兌現）

- `importers`：generic-csv、generic-text、聯邦銀行信用卡 CSV；moze-export、國泰與 LINE Bank 依 Q8/Q9 樣本到位後實作
- `audit-engine`：matching、差額求解、reasoning codes
- audit session UI（F4）、proposed patches 流程
- statements/statement_items、上傳檔案生命週期
- 多卡合併帳單：銀行 group 為第一層、每卡 statement/session 為第二層；現金回饋以 income-to-card 配對
- **退出條件**：作者一期真實帳單全流程審計，差額被解釋或明確標未解

### M4：資產一覽

- `investments`：TWD／USD／JPY 券商帳戶、可編輯標的、期初／買賣／股息分錄（F7）；價格由 TWSE／Finnhub provider 抓取，匯率仍手動維護，皆保存 as_of
- 首頁淨資產一覽 + 未來 30 天現金流 + 資料新鮮度
- **退出條件**：首頁一眼看到真實全貌，數字可信

### M5：Discord

- OAuth 連結/撤銷、隱私模式
- 查詢指令、`/finance add`（草稿）、`/finance confirm`
- 事件通知（去重/冷卻/quiet hours）、Web Push
- **退出條件**：作者一個月不主動開 PWA 也不會錯過繳款

### M6：AI 輔助

- BYOK 設定、provider 介面（含本地模型介面）
- PDF/髒文字欄位抽取、商家正規化、候選排序、解釋生成
- **退出條件**：AI 全停用時功能不減；啟用時審計確認時間再降
- **實作現況**（2026-07-18）：BYOK＝每使用者一組 OpenAI 相容端點（`ai_settings`，key 應用層加密）——自架 Ollama/LM Studio、Cloudflare Workers AI（`…/ai/v1`）、OpenRouter 同一介面通吃。欄位抽取＋商家正規化＝`POST /api/ai/extract-statement`；UI 保留原始來源並讓使用者確認整理稿後才匯入。`POST /api/ai/explain` 解釋單筆候選；`POST /api/ai/review-session` 產生整份摘要與人工複核順序。AI 不改規則分數、patch 或帳本；持久化 merchant alias 與歷史型 `PairScoreContext` 尚未實作。

## 3. 里程碑紀律

- 每個里程碑結束：文件同步更新、退出條件實測通過才進下一個。
- 里程碑內不夾帶下一階段功能（AGENTS §10）。
- 順序可因作者實際痛點調整（例如 M4 與 M5 可對調），但 M1→M2→M3 的依賴順序不可變。
