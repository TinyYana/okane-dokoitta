# OPEN_QUESTIONS — 未決事項

標記 🔴 = **需要人工決策**（影響資料正確性、安全性或同步模型，agent 不得自行拍板）；🟡 = 有推薦方案，作者不反對即照推薦執行；🟢 = 需要作者提供材料。

編號不重排；已解決項移至文末並保留編號。

## 🟡 Q5：基準貨幣

**推薦**：使用者設定，預設 TWD；淨資產與一覽以基準貨幣呈現。

## 🟡 Q6：M1 auth 的過渡形態

**背景**：Passkey 完整實作在 M2；M1 需要最簡登入保護 API。
**推薦**：M1 用單使用者密碼（argon2id）+ session cookie；M2 升級 Passkey 並保留密碼為備援。自架且尚未公網暴露時風險可控。

## 🟡 Q7：Web Push 與 Discord 的通知優先序

**推薦**：兩者皆做（M5），預設 Discord DM 優先（作者高頻使用）；Push 為輔。每事件可獨立設通道。

## 🟢 Q8：MOZE 匯出格式

需要作者提供 MOZE 實際匯出檔（CSV）樣本一份（可改假資料），才能定 `moze-export` importer 的欄位對應。

## 🟢 Q9：第一批銀行帳單樣本

聯邦銀行 CSV 樣本已於 2026-07-18 提供並完成 `union-bank-credit-card` 格式解析（真實檔只做本機驗證，repo 僅留去識別 fixture）；其多卡合併帳單的寫入模型另見 Q19。

國泰世華電子帳單樣本已於 2026-07-21 提供並完成 `cathay-credit-card` 格式解析（真實檔只做本機驗證，repo 僅留去識別 fixture）。輸入是瀏覽器端用 pdfjs 抽出的 PDF 文字層（多欄位排版被壓成一行、夾雜大量條款文字與加密浮水印區塊的亂碼），解析用固定形狀的 regex 認交易列（消費日 入帳日 商家 金額 [卡號末四碼 [行動卡號末四碼] 消費國家 幣別]），帳單摘要行（上期帳單總額、繳款小計、正卡本期消費…）因為前面沒有兩個日期，天然不會被規則吃到，不用另外用關鍵字排除。帳單日／繳款截止日／應繳總額能直接從文字抽出，通用文字匯入原本一定會卡的 `IMPORT_FIELDS_REQUIRED` 對這個格式不再出現。仍需要作者提供 LINE Bank 的**去識別化**帳單；未有樣本的來源繼續使用 generic-csv / generic-text，不猜銀行格式。

## 🟢 Q10：Discord bot 的伺服器/應用建立

M5 前需要作者在 Discord Developer Portal 建立 application（名稱 `okane-dokoitta`），提供 APP_ID / PUBLIC_KEY / BOT_TOKEN 到自架環境變數。

## 🔴 Q13：跨幣別交易（I-3）的平衡帳戶形態

**背景**：I-3 要求跨幣別交易拆成兩筆同幣別平衡的 entry + `fx_pair` link。每側 entry 需要一個「平衡端」帳戶承接對沖 line。M1 實作暫以 `opening_balance` equity 帳戶兼任平衡端（該帳戶已允許任意幣別 line，因為多幣別期初餘額本來就需要）。
**選項**：(a) 維持 opening_balance 兼任（少一個帳戶，但期初與換匯混在同一 equity 餘額）；(b) 新增 `fx_conversion` equity subtype 專用（語意乾淨，需擴充 DATA_MODEL 的 subtype enum）。
**推薦**：(b)，在 M4（匯率一覽）動工前定案即可——影響帳務資料語意，**需要人工決策**。M1 的 UI 未開放跨幣別轉帳，模型與測試已就緒。

## 🟡 Q11：投資「已實現損益」的分類歸屬

**背景**：賣出時的損益走 `category_income`（已實現損益）；虧損時為負收入還是獨立 expense 分類？
**推薦**：單一「已實現損益」income 分類，正負皆記於此（報表語意最清晰，不污染消費分類）。M4 實作前無異議即照此。

## 🟡 Q15：Discord/排程觸發的 mutation，audit_logs.actor 目前仍記 'user'

**背景**：`auditActor` enum 已含 `'discord'`，但 `packages/database/src/mutations.ts` 的 `audit()` helper 被 34 個呼叫點共用，實際 actor 寫死 `'user'`，沒有把呼叫來源（PWA / Discord bot）往下傳。`/finance add`、`/finance confirm` 目前都走 `applyMutation`（與 PWA 同一條路、一樣驗證與冪等），只是 audit log 裡看不出這筆是從 Discord 發起的。
**推薦**：先維持現狀——`user_id` 與資料本身正確，只是 actor 分類不夠精確，不影響資料正確性或安全性。若之後需要精確區分來源，把 `actor` 加進 `MutationUser` 並讓 `audit()` 及其 34 個呼叫點改吃這個欄位（一次性機械修改，非本次 M5 範圍）。

## 🟡 Q16：M5 通知事件尚未接上偵測邏輯

**背景**：`packages/notifications` 的 `NOTIFICATION_EVENT_TYPES` 已定義 `low_balance_warning`、`price_stale`、`sync_failed`、`backup_failed` 四種事件，但 `apps/api/src/notification-scheduler.ts` 目前只接了 `card_statement_upcoming`、`card_due_upcoming`、`expected_overdue`、`subscription_due`、`statement_ready`、`audit_discrepancy`、`audit_completed`。未接的四種缺對應資料來源：
- `low_balance_warning` 需要「預估未來餘額」邏輯（目前只有即時餘額，沒有計入即將到期的扣款）
- `price_stale` 需要逐一檢查 `market_prices` 的 `as_of` 是否超過門檻
- `sync_failed` / `backup_failed` 目前沒有寫入任何可查詢的失敗紀錄表
**推薦**：作者實際用過 M5 現有事件、確認排程與 quiet hours 運作正常後，再擴充這四種（`price_stale` 最簡單，可優先）。不阻塞 M5 其餘功能。

## 🟢 Q14：invest_buy 是否要拆出獨立手續費線

**背景**：`INVESTMENT_MODEL.md` §3 的範例表把買入手續費拆成獨立 expense line（交割 −5,020／投資資產 +5,000／手續費 +20）；M1 起實作的 posting rule（`invest_buy`）其實是單純兩條線，手續費目前併入總金額計入成本基礎，要單獨追蹤只能另記一筆 `fee` 交易。
**推薦**：先維持現狀（單人手動記帳，成本基礎正確即可，手續費占比通常很小）；若作者實際使用後覺得需要單獨看手續費金額，再擴充 `invest_buy` posting rule 支援選填的 `feeMinor` 欄位。M4 實作已按現狀落地，不阻塞。


## 🟡 Q12：帳單重匯的版本策略

**背景**：同一期帳單可能重複匯入（補寄、修正版）。
**推薦**：新 statement 取代舊版（舊版標 superseded、audit session 連動標記），statement_items 不可變不受影響。M3 實作前無異議即照此。

## 已解決

- **Q21 帳單匯入補記帳本的分類預設**（2026-07-18，作者拍板選項 b）：先用同商家歷史分類；沒有建議時預填「其他支出」並標 `needsReview`，可一鍵批次加入所有安全明細。每筆仍各自經 domain 驗證、冪等 mutation 與 audit log；使用者逐筆改選分類時視為已複核。海外交易手續費與現金回饋使用 Q17/Q20 專屬分類；退款缺原交易時只保留未解。
- **Q20 信用卡現金回饋入帳**（2026-07-18，作者核可推薦方案）：`income` 可入信用卡，分錄為卡負債減少 `+n`／收入分類 `-n`；聯邦負額「回饋」只找碰到該卡的 income 候選，不冒充 refund。
- **Q19 多卡合併帳單**（2026-07-18，作者核可推薦方案）：採 `statement_groups`（migration 0012、ADR-010）保存銀行合併應繳與原始檔，每卡各自 statement/session。審計歷史第一層只顯示銀行合併帳單，第二層才列卡片與本卡明細小計。
- **Q18 定期定額投資**（2026-07-18，作者拍板「圈存式」）：採選項 (a)——`recurring_rules` 擴充 `kind: 'invest_buy'`（migration 0009，帶 investmentAccountId、securityId；accountId＝server 解析的交割戶）。語意跟銀行圈存一樣：到期先以**預估金額**佔住 30 天預計流出（重用 expected_transactions 管線，免費拿到），確認時使用者填**實際成交金額與股數**才入帳（invest_buy 交易、平均成本法維護持倉、規則推進下期）。UI 在「週期」頁：新增規則可選「定期定額」、確認走專用對話框。
- **Q17 信用卡回饋與海外交易手續費**（2026-07-18，作者拍板）：回饋**只先處理現金折抵**，記獨立收入分類「信用卡回饋」（不高估消費、不污染退款語意；點數折抵不做）；海外交易手續費記獨立支出分類「海外交易手續費」。兩者已加入 `packages/domain` 預設分類，不動 schema 與 posting rule。後續 M3 對帳細化時把「回饋入帳行」「手續費行」納入可自動配對的帳單行類型。
- **Q1 License**（2026-07-17，作者核可）：**AGPL-3.0**。`LICENSE` 已加入，`package.json` 標 `AGPL-3.0-only`。
- **Q2 加密邊界**（2026-07-17，作者核可）：混合式（⑤）定案，ADR-003 → accepted。驗收基準：使用者之間互不可見（硬需求）＋整體低外洩風險；不要求 E2EE。使用者主密鑰加密（③）降為未來可選強化（備註、帳單原始檔優先），官方託管上線前重審。
- **Q3 多使用者**（2026-07-17，作者確認）：多使用者是**確定方向**，非單人假設。schema 全帶 `user_id` 且全查詢隔離（M1）；註冊/管理與 IDOR 測試在 M2（SEC-6）。多人「協作同一本帳」仍排除。
- **Q4 TWD 最小單位**（2026-07-17，作者核可）：`TWD=0`（1 元 = 1 minor unit），採銀行實務慣例。幣別註冊表保持**可擴充**（新增幣別＝加一列 code + exponent，不需 schema 變更），詳見 DATA_MODEL §1。
- 同步架構 → ADR-002（CRDT 明確拒絕）
- 部署平台 → ADR-004（Node 單體，非 Workers）
- Discord 架構 → ADR-005（interactions endpoint）
- Importer 形態 → ADR-007（in-repo 插件）
- 投資價格來源 → ADR-008（台股 TWSE／美股 Finnhub 自動報價；不讓使用者手抄價格）
