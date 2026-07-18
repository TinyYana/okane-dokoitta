# AUDIT_ENGINE — 自動審計與配對引擎

相關 ADR：ADR-006（AI 邊界）、ADR-007（Importer）。實作 package：`packages/audit-engine`。表定義見 `docs/DATA_MODEL.md` §4。

核心原則：**rule-based engine 是真相來源，每個結論都附證據；AI 只做排序與解釋的輔助，永不直接寫帳。**

## 1. 審計 pipeline

```text
建立 audit session（狀態 created）
→ 解析帳單（importer → NormalizedStatement；狀態 parsing）
→ 驗證帳單自身：明細加總 == 帳單總額？（不等→先標記，帶著差異繼續）
→ 正規化明細（merchant_aliases + 規則）
→ 找出候選交易（帳本側撈取範圍：帳單期間 ± lookback）
→ matching engine 配對（§3）
→ 計算未配對與差額
→ 差額求解（§6）
→ 產生 audit_candidates + proposed_patches
→ 使用者逐項確認（狀態 reviewing；可中斷續作）
→ patch 套用：使用者確認 → domain 驗證 → 寫入 → audit log
→ 重算是否平衡 → 建立/更新 statement、預計扣款
→ 封存報告（狀態 completed → archived）
```

Session 是可續作的：所有中間結果落在 `audit_candidates`，關掉頁面回來繼續。同一張帳單重匯 → 新 session，舊 session 標 superseded。

## 2. 配對候選的撈取範圍

帳本側候選 = 該卡（或未指卡但金額幣別吻合）的交易，日期在 `[period_start − 45d, period_end + 10d]`，狀態非 cancelled。上限 500 筆（超過→告警並收窄日期）。

## 3. Matching engine（rule-based 評分）

每對 (statement_item, transaction) 依規則累積分數，每條命中規則產生一個 reasoning code + evidence：

| 訊號 | 說明 | 權重方向 |
|---|---|---|
| 金額完全相同 | 同幣別同額 | 強 + |
| 金額差 10 倍 | 少/多打一個 0 | 中 +（帶 `AMT_TENFOLD`） |
| 金額差常見誤差 | ±10、±100、±1,000 | 中 + |
| 商家相似度 | alias 命中 > 正規化後相等 > 字串相似（token/trigram） | 強～弱 + |
| 日期距離 | occurred 對 occurred；容許入帳延遲 0–5 天（posted 對 posted） | 近 +／遠 − |
| 入帳延遲模式 | 該商家/卡的歷史延遲天數 | 中 + |
| 卡號末四碼 | 相符/不符 | 強 +／強 − |
| 幣別 | 相符；外幣消費的匯率換算在容差內（`FX_ROUNDING`） | 中 + |
| 分期 | current/total 相符 | 強 + |
| 退款配對 | 負額 item 對正額原交易 | 強 + |
| 使用者歷史 | 過往確認過同型配對/修正 | 中 + |
| 總額平衡 | 接受此配對後帳單差額歸零 | 加成 |

輸出分層：

- `score ≥ 0.9` 且無矛盾訊號 → **高可信度**（預設勾選，仍需使用者一鍵確認）
- `0.6 ≤ score < 0.9` → **低可信度**（逐筆呈現證據）
- `< 0.6` → 不建議，落入「帳單有、帳本無」清單

每個候選**必須**帶：`score`、`reasoning_codes[]`、`evidence`（各規則的具體數值）、`explanation`（人話：「金額相同、日期差 2 天、商家 alias 命中『全聯』」）、`proposed_patch`。**禁止只回一個信心值。**

## 4. Reasoning codes（初始目錄）

```text
AMT_EXACT, AMT_TENFOLD, AMT_OFFSET_10, AMT_OFFSET_100, AMT_OFFSET_1000,
AMT_SIGN_FLIPPED, FX_RATE_WITHIN_TOL, FX_ROUNDING,
DATE_SAME, DATE_WITHIN_TOL, POSTING_LAG_TYPICAL, DATE_FAR,
MERCHANT_ALIAS, MERCHANT_NORMALIZED_EQ, MERCHANT_FUZZY, MERCHANT_MISMATCH,
CARD_LAST4_MATCH, CARD_LAST4_MISMATCH,
INSTALLMENT_SEQ_MATCH, INSTALLMENT_MISMATCH,
REFUND_PAIR, DUPLICATE_SUSPECT, USER_HISTORY_MATCH,
BALANCES_STATEMENT
```

目錄由 domain 維護成 enum；新增 code 需附測試。

## 5. 審計報告（session.stats）

報告至少含：帳單總額、帳本預期總額、差額、自動配對數、高/低可信度數、帳單有帳本無、帳本有帳單無、金額疑誤、日期疑誤、疑似選錯卡、疑似重複、退款缺原交易、延後入帳、分期差異、**修正後是否平衡**。

## 6. 差額求解（discrepancy solver）

輸入：`D = 帳單總額 − 已配對帳本總額`。若 `D = 0` 跳過。

依序嘗試（找到足以解釋 D 的假說即提前結束該層）：

1. **單筆**：某未配對項金額 == |D|；或某已配對項的金額差 == D（記錯金額）。O(n)。
2. **常見錯誤型**：正負號錯（某項 ×−1 修正 D）、十倍誤差、幣別/小數點錯、繳款被記成支出（金額=繳款額）、退款未抵銷、轉帳缺一端、帳單期間切錯（頭尾幾天的交易）。每型是一條獨立規則，O(n)。
3. **兩筆組合**：hash set 找 a+b == D。O(n)。
4. **三筆組合**：僅在前面全失敗時跑。O(n²)（固定一筆 + two-sum）。

**效能上限（硬性）**：候選 n ≤ 300（超過→收窄日期區間後重試）；三筆搜尋 wall-clock 上限 2 秒，超時中止並回報「未能自動解釋差額」；不搜尋四筆以上——指數爆炸且假說可信度過低，剩餘差額直接列為未解，交給使用者。

多個假說並存時全部列出，按（可解釋差額比例、規則可信度、涉及筆數少者優先）排序。

## 7. Proposed patches

所有修正動作物化為 `proposed_patches`（kind 見 DATA_MODEL §4），流程：

```text
規則/AI/使用者 產生 patch（status: proposed）
→ 使用者在 audit UI 逐項 接受/拒絕
→ 接受 → domain service 驗證（posting rules、不變量）
→ 通過 → 寫入帳本 + audit_logs（actor=patch, 關聯 session）→ status: applied
→ 失敗 → status: failed + 原因（不部分套用）
```

批次接受只是逐筆套用的 UI 糖，每筆仍獨立驗證與記錄。帳單有而帳本沒有的正額消費／手續費，以及可辨識的現金回饋，產生 `create_transaction`：先採同商家歷史分類，無建議則使用專屬分類或「其他支出 + needsReview」。使用者可先改分類，也可批次加入；缺少分類時不得套用。**任何繞過此流程的帳本寫入都是 bug（ADR-006）。**

每個候選都必須有 patch。能安全連結既有事實時使用 `assign_statement`，能由帳單建立完整合法分錄時使用 `create_transaction`；退款缺原交易等必要會計事實或差額仍未解時使用 `acknowledge_unresolved`。後者只記錄人工確認與 audit log，不寫入帳本，也不把差額假裝成已平衡。

候選不可繞過 patch 直接改 decision；decision 由 patch 套用／拒絕的同一個 transaction 推進。完成 session 前，所有 candidates 必須非 pending，且所有 patches 必須離開 proposed／accepted 狀態。Patch row 以資料庫鎖序列化，重複接受不會重複寫帳或倒退狀態。

Patch 因目標已變更、版本衝突或 domain 驗證失敗時保留 `failed + failure_code`，不寫帳；使用者可在看見原因後「關閉失敗提案」，把 candidate 明確標為 rejected，再完成 session。失敗不得自動算成接受，也不得讓 session 永久無法結案。

## 8. AI 輔助層（M6，可停用）

AI 可插入的點：importer 的欄位抽取（PDF/髒文字）、商家正規化建議（寫入 merchant_aliases 前仍需確認）、候選排序調整（依使用者歷史錯誤模式）、把 reasoning codes 轉成更自然的解釋文字。

AI 停用時：所有上述環節退回純規則版本，審計功能完整可用（準確率較低而已）。AI 的任何輸出都只能落在 `proposed_patches(origin=ai)` 或候選排序，經過與規則相同的確認流程。

**實作現況**（2026-07-18）：`/api/ai/extract-statement` 產生欄位抽取＋商家正規化整理稿；UI 分開保留原文與整理稿，只有使用者確認後才送入既有匯入管線，R2 保存的仍是原始來源。`/api/ai/explain` 把單筆候選 reasoning codes＋evidence 轉白話；`/api/ai/review-session` 產生整份摘要與人工複核順序。兩者只影響顯示，不改 rule score、patch 或帳本。持久化 merchant alias 與 `PairScoreContext` 歷史調整尚未實作。

## 9. 測試要求

- matching 規則逐條單元測試（給定 item+txn → 預期 codes 與分數區間）。
- 差額求解每個錯誤型至少一個 fixture（含「無法解釋」案例）。
- 效能測試：n=300 的三筆搜尋在上限內完成。
- 端到端 fixture：一張去識別化帳單 + 帳本 → 預期報告。
