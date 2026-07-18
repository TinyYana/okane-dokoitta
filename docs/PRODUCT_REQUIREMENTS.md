# PRODUCT_REQUIREMENTS — 功能需求總表

需求編號規則：`<領域>-<序號>`。每條需求標記所屬里程碑（見 `docs/ROADMAP.md`）。
「MVP」指 M1–M3：作者可完成「記帳 → 同步 → 匯入帳單 → 審計」的完整工作流。

## 1. PWA 客戶端（PWA-*）

| ID | 需求 | 里程碑 |
|---|---|---|
| PWA-1 | iPhone 加入主畫面後可獨立全螢幕使用（standalone manifest） | M1 |
| PWA-2 | iPad、Mac、Windows 現代瀏覽器可用，responsive UI；手機用有安全區留白的浮動導覽，桌面用側邊導覽 | M1 |
| PWA-3 | 深色與淺色模式，跟隨系統並可手動切換 | M1 |
| PWA-4 | 手機上快速記帳：常用帳戶/分類預設，選項單列橫向滑動，目標 3 次點擊內完成一筆 | M1 |
| PWA-5 | 離線可新增/編輯交易，網路恢復後自動同步 | M2 |
| PWA-6 | Web Push 通知（iOS 16.4+ 已支援 PWA push） | M5 |
| PWA-7 | 從分享選單或檔案選擇器匯入帳單檔案 | M3 |
| PWA-8 | 同步狀態顯示（已同步/排隊中/衝突）與手動重新同步 | M2 |
| PWA-9 | 不依賴 App Store；架構不封死未來原生包裝 | 恆常 |

## 2. 雲端同步（SYNC-*）

詳細設計見 `docs/SYNC_DESIGN.md`。

| ID | 需求 | 里程碑 |
|---|---|---|
| SYNC-1 | 多裝置使用同一帳本，server-authoritative | M1（單機）/ M2（多裝置） |
| SYNC-2 | 本機 IndexedDB 快取 + 離線 mutation outbox | M2 |
| SYNC-3 | 所有 mutation 冪等（client 產生 mutationId） | M1 起 |
| SYNC-4 | 樂觀版本檢查；衝突不得靜默覆寫，必須浮上 UI 由使用者解決 | M2 |
| SYNC-5 | 軟刪除；帳務資料不物理刪除 | M1 起 |
| SYNC-6 | 完整 audit log：所有寫入記錄 who/when/what/before/after/via | M1 起 |
| SYNC-7 | 裝置識別與管理（列出、命名、撤銷） | M2 |
| SYNC-8 | 完整匯出（JSON + CSV）與還原到新實例 | M1（匯出）/ M2（還原） |

## 3. 帳戶與信用卡（ACCT-*）

| ID | 需求 | 里程碑 |
|---|---|---|
| ACCT-1 | 帳戶類型：現金、銀行存款、數位帳戶、電子支付、信用卡、投資交割、券商、其他資產、其他負債 | M1 |
| ACCT-2 | 帳戶封存（不刪除、不再出現在快速選單，歷史保留） | M1 |
| ACCT-3 | 信用卡欄位：發卡機構、卡片名稱、末四碼、額度、結帳日、繳款截止日、自動扣款日、自動扣款帳戶、狀態 | M1 |
| ACCT-4 | 共用額度群組：多張卡共用一個總額度 | M1 |
| ACCT-5 | 信用卡週期視圖：本期已入帳、待入帳、已出帳、待繳款、已繳款、退款、分期 | M1 |
| ACCT-6 | 帳戶群組（顯示用分組） | M1（可延後） |
| ACCT-7 | 永不儲存完整卡號、網銀/券商密碼 | 恆常 |

## 4. 交易、日期與狀態（TXN-*）

詳細模型見 `docs/DATA_MODEL.md`。

| ID | 需求 | 里程碑 |
|---|---|---|
| TXN-1 | 交易日期欄位分離：occurred_at、authorized_at、posted_at、statement_date、due_date、scheduled_payment_at、settled_at、created_at、updated_at | M1 |
| TXN-2 | 交易狀態可表達：draft、expected、pending、posted、statement、due、settled、refunded、cancelled、disputed、needs_review（跨 transaction/statement/expected 三層建模，見 DATA_MODEL 4.3） | M1 |
| TXN-3 | 金額一律整數最小貨幣單位；禁止浮點數 | 恆常 |
| TXN-4 | 內部複式帳本：信用卡繳款＝轉帳；投資買入＝資產轉換；退款連結原交易 | M1 |
| TXN-5 | 轉帳為單一交易（兩條 journal lines），不是兩筆孤立交易 | M1 |
| TXN-6 | 分期交易：期數（current/total）、母子關係 | M1（模型）/ M3（對帳） |
| TXN-7 | 多幣別交易與匯率記錄 | M1（模型）/ M4（一覽） |
| TXN-8 | 商家與過去交易完全吻合時可透明帶入最常用分類；必須顯示依據且儲存前可改，不得黑箱寫帳 | M1 |

## 5. 週期扣款與預計交易（RECUR-*）

| ID | 需求 | 里程碑 |
|---|---|---|
| RECUR-1 | 固定金額訂閱與浮動金額帳單；每週/每月/每年/自訂週期 | M1 |
| RECUR-2 | 預計扣款日 + 日期容差 + 金額容差 | M1 |
| RECUR-3 | 指定支付帳戶或信用卡 | M1 |
| RECUR-4 | 實際交易出現後自動配對到預計交易 | M3 |
| RECUR-5 | 逾期未出現 → 提醒；使用者確認後轉為正式交易 | M1（手動確認）/ M5（提醒） |

## 6. 帳單匯入與自動審計（AUDIT-*）

詳細設計見 `docs/AUDIT_ENGINE.md` 與 `docs/IMPORTER_SYSTEM.md`。

| ID | 需求 | 里程碑 |
|---|---|---|
| AUDIT-1 | 匯入形式：CSV、PDF（含文字層）、貼上文字、手動輸入總額+明細、MOZE 匯出、通用交易清單 | M3 起分批 |
| AUDIT-2 | Importer 插件架構，統一 normalized statement format | M3 |
| AUDIT-3 | 每次匯入建立獨立 audit session，可中斷續作、封存報告 | M3 |
| AUDIT-4 | Rule-based matching engine：每個候選附 score、evidence、reasoning codes、可讀解釋、proposed patch | M3 |
| AUDIT-5 | 差額求解：單筆/兩筆/三筆組合、重複、缺漏、正負號、轉帳缺端、繳款重算、退款未抵銷；有明確效能上限 | M3 |
| AUDIT-6 | 審計報告：帳單總額、帳本預期、差額、配對統計、各類差異清單、修正後是否平衡 | M3 |
| AUDIT-7 | 所有修正經 proposed patch → 使用者確認 → domain 驗證 → 寫入 + audit log | M3 |
| AUDIT-8 | 明確排除：財政部發票 API、銀行/券商帳密登入、未授權爬取 | 恆常 |
| AUDIT-9 | 帳單缺漏可成為待確認記帳草稿；歷史分類優先、未知歸「其他支出」並待複核，且可批次逐筆安全套用 | M3 |

## 7. 投資與資產一覽（INV-*）

詳細模型見 `docs/INVESTMENT_MODEL.md`。

| ID | 需求 | 里程碑 |
|---|---|---|
| INV-1 | 券商帳戶、台股/美股/ETF、現金部位維護；標的主檔可編輯且持倉幣別必須與投資帳戶一致 | M4 |
| INV-2 | 持倉：代號、數量、平均成本、目前價格、市值、未實現損益、幣別 | M4 |
| INV-3 | 價格由 provider 自動抓取（台股 TWSE、美股 Finnhub），匯率現階段手動更新；皆記錄 as_of 與來源並支援過期提醒 | M4 |
| INV-4 | 買入/賣出/股息/手續費/稅 走複式帳本，不混入一般消費/收入 | M4 |
| INV-5 | 投資帳戶顯示須區分台股、臺灣券商外幣複委託與其他外幣投資，並顯示帳務幣別 | M4 |
| INV-5 | 首頁資產一覽：可用現金、銀行存款、投資市值、信用卡負債、其他負債、淨資產、未來 30 天預計流入/流出、資料最後更新時間 | M4 |

## 8. Discord 整合（DISC-*）

詳細設計見 `docs/DISCORD_INTEGRATION.md`。

| ID | 需求 | 里程碑 |
|---|---|---|
| DISC-1 | OAuth 帳號連結 + 可撤銷 | M5 |
| DISC-2 | 財務資訊只出現在 DM 或 ephemeral response；公開頻道零洩漏 | 恆常 |
| DISC-3 | 查詢指令：status、networth、upcoming、cards、pending、audit-status、reminders | M5 |
| DISC-4 | 寫入指令僅低風險：add（建立草稿）、confirm（確認預計交易），且需二次確認 | M5 |
| DISC-5 | 事件通知：結帳/扣款提醒、餘額不足預警、審計結果、同步失敗、價格過期 | M5 |
| DISC-6 | 通知去重、冷卻、頻率可調 | M5 |
| DISC-7 | 金額顯示模式：完整/模糊/僅異常/隱藏，使用者可設定 | M5 |
| DISC-8 | Bot 不直接連 DB；一律經正式 API 與 domain service | 恆常 |

## 9. AI 輔助（AI-*）

| ID | 需求 | 里程碑 |
|---|---|---|
| AI-1 | AI 模組可選、可替換、可停用；停用時核心功能完整可用 | 恆常 |
| AI-2 | 用途限定：欄位抽取、商家正規化、髒資料理解、候選排序、證據轉自然語言 | M6 |
| AI-3 | AI 永不直接寫入帳本；一律走 proposed patch 流程 | 恆常 |
| AI-4 | BYOK（使用者自帶 API key）；預留本地/自架模型介面 | M6 |

## 10. 安全（SEC-*）

完整清單見 `docs/SECURITY.md`；該文件的最低安全需求全數為驗收條件。核心摘要：

| ID | 需求 | 里程碑 |
|---|---|---|
| SEC-1 | HTTPS、Secure/HttpOnly/SameSite cookie、CSRF 防護、CSP、rate limiting | M1 |
| SEC-2 | Passkey（WebAuthn）為主要登入；可選 TOTP；session 管理與裝置撤銷 | M2 |
| SEC-3 | Secrets 不進 repo；DB 最小權限；敏感欄位 log redaction | M1 |
| SEC-4 | 備份加密與還原測試 | M2 |
| SEC-5 | 上傳檔案生命週期管理；解析在受限環境執行 | M3 |
| SEC-6 | 多使用者實例：註冊（或邀請制）、所有查詢 `user_id` 隔離、跨使用者 IDOR 整合測試 | M1（隔離）/ M2（註冊+測試） |

## 11. 明確排除（第一版不做）

- 原生 iOS/Android/桌面 App
- 銀行/券商自動登入、爬取、Open Banking 介接
- 財政部電子發票 API
- 多人協作同一本帳（共用帳本）——多使用者「各自獨立帳本」則是支援的（SEC-6，M2）
- 預算功能、財務健康評分、消費分析報告（分析類功能連提案都需先過 `docs/PRODUCT_VISION.md` 語氣審查）
- 即時行情推播與高頻輪詢（目前是使用者觸發 provider 抓取最新可用報價，見 ADR-008）
