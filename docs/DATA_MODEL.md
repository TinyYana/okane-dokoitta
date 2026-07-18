# DATA_MODEL — 資料模型與帳務不變量

相關 ADR：ADR-001（帳務模型）。DB：PostgreSQL，schema `okane_dokoitta`。

## 1. 全域慣例

- **主鍵**：UUIDv7，client 端產生（支援離線建立）。例外（M1 定案）：非 client 建立的衍生實體——journal entries/lines、audit logs、由 rule 展開的 expected_transactions、auth 資料——由 server 產生 UUIDv7。
- **金額**：`amount_minor bigint`，整數最小貨幣單位 + `currency char(3)`。**禁止浮點數**。
- **幣別最小單位指數**：由 domain 的 currency 註冊表定義：`TWD=0`（銀行以整數元計費；ISO 4217 名義上為 2，本專案採實務慣例——作者已確認，OPEN_QUESTIONS Q4）、`JPY=0`、`USD=2`。註冊表**可擴充**：新增幣別＝在表中加一列（code + exponent + 顯示符號），不需 schema 變更；金額欄位一律以 `(amount_minor, currency)` 成對出現，任何運算先查指數。
- **日期**：`*_date` = 民用日期 `date`（帳本時區解讀，預設 `Asia/Taipei`）；`*_at` = `timestamptz`（UTC）。
- **軟刪除**：帳務資料一律 `deleted_at timestamptz null`，不物理刪除。
- **版本**：可同步實體帶 `version integer`（樂觀鎖）與 `updated_at`。
- **多使用者**：確定方向（作者已確認，不是單人假設）。所有使用者資料帶 `user_id`，所有查詢/寫入必須以 `user_id` 界定（AGENTS §7）。MVP 以作者單人使用驗證；M2 起開放多使用者註冊與跨使用者隔離測試。
- **audit**：所有寫入經 domain service，寫 `audit_logs`。

## 2. 實體總表與里程碑

| 實體 | 說明 | 里程碑 |
|---|---|---|
| users, instance_state, auth_credentials, sessions | 使用者、首次架設原子 claim 與登入 | M1（最簡）/ M2（passkey 完整） |
| accounts | 所有帳戶（資產/負債/分類） | M1 核心 |
| account_groups | 顯示用分組 | M1（可延後） |
| credit_cards | 信用卡擴充屬性 | M1 核心 |
| credit_limit_groups | 共用額度群組 | M1 核心 |
| journal_entries, journal_lines | 複式帳本 | M1 核心 |
| transactions | 使用者面向交易 | M1 核心 |
| transaction_links | 交易關聯（退款/分期/重複） | M1 核心 |
| recurring_rules, expected_transactions | 週期規則與預計交易 | M1 核心 |
| exchange_rates | 匯率 | M1（模型）/ M4（一覽用） |
| audit_logs | 寫入稽核 | M1 核心 |
| sync_devices, sync_mutations, change_log | 同步 | M2 |
| statements, statement_items | 帳單 | M3 |
| import_files | 上傳檔案 metadata | M3 |
| audit_sessions, audit_candidates, proposed_patches | 審計 | M3 |
| merchant_aliases | 商家別名 | M3 |
| jobs | 背景工作 | M3 |
| investment_accounts, securities, holdings, market_prices | 投資 | M4 |
| discord_links, notification_preferences, notification_log | Discord 與通知 | M5 |
| ai_settings | BYOK 設定 | M6 |

## 3. 帳務核心

### 3.1 accounts

一切皆帳戶——資產、負債、還有**分類**（收支分類內部建模為 income/expense 帳戶，天然參與複式平衡；UI 稱「分類」）。

```text
accounts
  id, user_id
  kind        enum: asset | liability | income | expense | equity
  subtype     enum: cash | bank | digital | e_wallet | credit_card |
                    brokerage_settlement | investment_asset |
                    other_asset | other_liability |
                    category_income | category_expense | opening_balance
  name, currency
  institution text null   -- 所屬機構（銀行/電支/券商，顯示用；信用卡發卡行在 credit_cards.issuer）
  group_id    → account_groups (nullable)
  archived_at timestamptz null
  version, created_at, updated_at, deleted_at
```

- 期初餘額：建帳戶時對 `opening_balance` equity 帳戶做一筆平衡分錄，不直接塞餘額欄位。**帳戶餘額永遠是 journal_lines 的加總，不是可編輯欄位。** 每位使用者最多一個 `opening_balance`（migration 0013 partial unique index）；舊資料若把它軟刪除，下一筆期初調整會復原，完全不存在才以衝突安全的方式建立。
- 封存＝`archived_at` 設值；不出現在快速選單，歷史照常。
- `institution`（2026-07-18，migration 0008）：選填的顯示層資訊，讓清單／記帳 chip／淨資產泡泡標出是哪家銀行；同一機構可以有多個帳戶。投資帳戶建立時會把券商寫進配對的交割與資產帳戶。

### 3.2 credit_cards / credit_limit_groups

```text
credit_cards（1:1 擴充某個 subtype=credit_card 的 account）
  account_id (PK → accounts)
  issuer, card_name, last4 char(4)          -- 永不存完整卡號
  credit_limit_minor bigint null            -- 卡自身額度（若獨立）
  limit_group_id → credit_limit_groups null -- 共用額度時指向群組
  statement_day smallint                    -- 結帳日（每月幾號；月底規則見 §6）
  due_day smallint                          -- 繳款截止日
  autopay_day smallint null
  autopay_account_id → accounts null
  status enum: active | frozen | cancelled

credit_limit_groups
  id, user_id, name, issuer, limit_minor bigint
```

「本期已入帳／待入帳／已出帳／待繳款…」是**查詢視圖**（由 transactions 狀態 + statements 推導），不是儲存欄位。

### 3.3 journal_entries / journal_lines

```text
journal_entries
  id, user_id
  entry_date date              -- 記帳基準日（=交易 occurred 日）
  description
  transaction_id → transactions (1:1)
  created_at

journal_lines
  id, entry_id, line_no
  account_id → accounts
  amount_minor bigint          -- 有號：資產/費用增加為正…（正負規約由 domain 統一定義）
  currency char(3)
```

**不變量（domain service 強制，DB constraint 輔助）**：

- I-1：每個 entry 至少 2 條 lines。
- I-2：每個 entry 內，**每個幣別**的 lines 總和為 0。
- I-3：跨幣別交易（如美元消費台幣繳款）拆成兩個同幣別平衡的 entry，以 `transaction_links(kind=fx_pair)` 連結，並記錄成交匯率。
- I-4：lines 不可直接被 API 寫入；只能由 domain posting rules 從 transaction 產生。

### 3.4 posting rules（範例）

| 交易類型 | Lines |
|---|---|
| 現金/銀行支出 185 | `category_expense:餐飲 +185`；`asset:銀行 −185` |
| 信用卡消費 185 | `category_expense:餐飲 +185`；`liability:信用卡 +185` |
| 信用卡繳款 6,842 | `liability:信用卡 −6,842`；`asset:銀行 −6,842` ← **是轉帳，不產生 expense line** |
| 帳戶間轉帳 | `asset:A −n`；`asset:B +n` |
| 退款 | 原分錄反向，並 link 原交易 |
| 買 ETF 5,000 | `asset:investment_asset +5,000`；`asset:交割帳戶 −5,000` ← **不產生 expense line** |
| 股息 | `asset:交割帳戶 +n`；`category_income:股息 +n` |
| 手續費/稅 | `category_expense:手續費 +n`；對應資產/負債 −n |

（文件此表只定「增減語意」。精確符號規約已在 `packages/domain` 定案並以測試釘死（M1）：**`amount_minor` 正＝借方、負＝貸方**——資產與費用增加記正；負債、收入與 equity 增加記負，因此每個 entry 每幣別總和恆為 0。）

### 3.5 transactions（使用者面向層）

```text
transactions
  id, user_id
  type enum: expense | income | transfer | card_payment | refund |
             invest_buy | invest_sell | dividend | fee | tax | adjustment
  status enum: draft | expected | pending | posted | cancelled | disputed
  needs_review boolean default false        -- 獨立旗標，可與任何 status 並存
  amount_minor, currency
  from_account_id, to_account_id, category_account_id   -- 依 type 取用
  merchant_raw, merchant_normalized, note
  -- 日期群（TXN-1）：
  occurred_at timestamptz          -- 實際消費/事件發生
  authorized_at timestamptz null   -- 授權
  posted_at timestamptz null       -- 入帳
  statement_id → statements null   -- 所屬帳單期（=規格的 statement_cycle_id）
  statement_date date null         -- 帳單日（冗餘自 statement，匯入時可先有值）
  due_date date null
  scheduled_payment_at timestamptz null
  settled_at timestamptz null
  installment_current, installment_total smallint null
  recurring_rule_id null, expected_transaction_id null
  source enum: manual | import | recurring | discord_draft | patch
  version, created_at, updated_at, deleted_at
```

### 3.6 狀態的三層建模

規格列出的 11 種狀態拆到三個實體，避免單一 mega-enum 無法表達「pending 且 needs_review」這類組合：

| 規格狀態 | 落點 |
|---|---|
| draft / expected / pending / posted / cancelled / disputed | `transactions.status` |
| needs_review | `transactions.needs_review` 旗標 |
| refunded | `transaction_links(kind=refund)` + 原交易可查有退款 |
| statement / due / settled | 信用卡交易：由 `statement_id` + `statements.status` 推導；繳款與預計交易：`settled_at` |

`transactions.status` 轉移：

```text
draft ────► pending ──► posted ──► (cancelled | disputed)
expected ─► pending（實際交易出現並確認）
draft/expected/pending 皆可 → cancelled
```

`statements.status`：`open → closed → due → paid`（逾期為 `due` + 過了 due_date 的推導條件）。
`expected_transactions.status`：`scheduled → matched → confirmed`；或 `scheduled → missed | skipped`。

### 3.7 transaction_links

```text
transaction_links
  id, user_id, kind enum: refund | installment_parent | fx_pair |
                          duplicate_of | payment_for_statement | correction
  from_transaction_id, to_transaction_id
  metadata jsonb
```

### 3.8 recurring_rules / expected_transactions

```text
recurring_rules
  id, user_id, name
  schedule: freq enum(weekly|monthly|yearly|custom_days), interval smallint,
            day_of_month smallint null, month smallint null, custom_every_days null
  amount_minor bigint null      -- 固定金額；null=浮動
  amount_tolerance_minor bigint -- 金額容差
  date_tolerance_days smallint
  account_id → accounts         -- 扣款帳戶或信用卡；invest_buy 時＝交割戶（server 解析）
  category_account_id, merchant_hint
  kind enum: expense | invest_buy  -- 定期定額（Q18 圈存式，migration 0009）
  investment_account_id null, security_id null  -- kind=invest_buy 用
  active boolean, next_expected_date date

expected_transactions（由 rule 展開，或審計建立）
  id, user_id, rule_id null
  expected_date date, amount_minor, currency, account_id
  status enum: scheduled | matched | confirmed | missed | skipped
  matched_transaction_id null
```

## 4. 帳單與審計（M3）

```text
statement_groups（銀行同一原始檔合併多張卡；ADR-010）
  id, user_id, import_file_id unique, institution
  period_start date, period_end date, statement_date date, due_date date
  total_minor bigint, currency       -- 銀行聲稱的合併應繳

statements
  id, user_id, credit_card_account_id
  period_start date, period_end date, statement_date date, due_date date
  total_minor bigint, currency
  minimum_due_minor null, previous_balance_minor null
  status enum: open | closed | due | paid
  import_file_id null, group_id null, audit_session_id null
  -- group_id 有值時 total_minor 是本卡明細小計；同 group 每張卡只能一份 statement

statement_items（帳單明細，匯入的原始事實，不可變）
  id, statement_id, line_no
  merchant_raw, merchant_normalized
  amount_minor, currency
  occurred_date null, posted_date null
  card_last4 null, installment_current/total null
  raw jsonb                     -- importer 原始欄位全保留
  matched_transaction_id null

audit_sessions
  id, user_id, statement_id
  status enum: created | parsing | matching | reviewing | completed | archived
  stats jsonb                   -- 報告數據（見 AUDIT_ENGINE §5）
  created_at, completed_at

audit_candidates
  id, session_id, statement_item_id null, transaction_id null
  kind enum: match | missing_in_ledger | missing_in_statement |
             amount_mismatch | date_mismatch | wrong_card |
             duplicate | refund_unlinked | deferred_posting | installment_issue
  score numeric(5,4)            -- 0..1（分數非金額，允許 numeric）
  reasoning_codes text[]        -- 見 AUDIT_ENGINE §4
  evidence jsonb
  explanation text              -- 人類可讀
  proposed_patch_id null
  resolution enum: pending | accepted | rejected | superseded

proposed_patches
  id, user_id, session_id null
  kind enum: create_transaction | update_transaction | merge_duplicates |
             link_refund | assign_statement | create_expected | adjust_amount |
             acknowledge_unresolved
  payload jsonb                 -- domain 驗證的結構化 patch
  origin enum: rule | ai | user
  status enum: proposed | accepted | rejected | applied | failed
  applied_at, applied_audit_log_id null

merchant_aliases
  id, user_id, pattern, normalized, source enum: user | rule | ai, hit_count

import_files
  id, user_id, filename, mime, size, sha256
  storage_path（加密存放）, importer_id null
  status enum: uploaded | parsed | failed | purged
  retain_until date             -- 生命週期（SECURITY §6）
```

`acknowledge_unresolved` 不修改帳本；它把候選明確標記為「已人工確認但仍未解」，並留下 audit log。這讓每個候選都有 proposed patch，又不會在缺少帳戶、分類或交易事實時假造會計分錄。

## 5. 投資（M4）·同步（M2）·通知（M5）

實作註記（2026-07-18）：以下為實際落地的 schema；與早期草案相比，`holdings` 存**總成本**而非平均成本（除法延後到顯示層才算，避免多次買賣的捨入誤差累積），`market_prices.price`／`exchange_rates.rate` 用十進位字串（非 bigint minor units；股價/匯率是比率不是金額，運算集中在 domain money module，見 §1），`securities.market` 是自由文字而非枚舉（避免未來加新市場要改 schema）。

```text
investment_accounts
  id, user_id, name
  settlement_account_id → accounts   -- 交割現金帳戶（asset, subtype=brokerage_settlement）
  asset_account_id → accounts        -- 投資資產帳戶（asset, subtype=investment_asset；記成本基礎）
  version, created_at, updated_at, deleted_at null

securities
  id, user_id, symbol, name, market text（自由文字，如 TW/US）, currency（報價幣別）, kind enum: stock | etf
  version, created_at, deleted_at null

holdings
  id, user_id, asset_account_id → accounts, security_id → securities
  quantity_micro bigint              -- 股數固定 6 位小數精度（micro units，domain/investments.ts）
  cost_basis_minor bigint            -- 總成本基礎（非均價）；均價 = cost_basis_minor / quantity_micro
  version, updated_at
  unique(asset_account_id, security_id)

market_prices（append-only 價格快照）
  id, security_id → securities, price text（十進位字串）
  as_of timestamptz, source enum: manual | provider

exchange_rates（append-only 匯率快照；全域資料，非使用者範疇）
  id, base char(3), quote char(3), rate text（十進位字串）
  as_of timestamptz, source enum: manual | provider

users.base_currency char(3) default 'TWD'  -- 淨資產一覽的換算基準幣別（M4）
transactions.security_id / quantity_micro  -- invest_buy/invest_sell/dividend 附的標的與股數（可為 null）

sync_devices
  id, user_id, name, platform, last_seen_at, revoked_at null

sync_mutations（冪等鍵與稽核，見 SYNC_DESIGN；M1 起落地）
  mutation_id (PK, client 產生), user_id, device_id
  entity, entity_id, op enum: create | update | delete
  base_version integer null, payload jsonb
  result enum: applied | rejected_conflict | rejected_invalid | duplicate
  applied_version integer null   -- 首次套用後的版本（重送同 mutation_id 時回傳首次結果用）
  error_code text null
  applied_at

change_log（change feed）
  seq bigserial (PK), user_id, entity, entity_id, version, changed_at

audit_logs
  id, user_id, actor enum: user | system | discord | patch | sync
  entity, entity_id, action, before jsonb, after jsonb
  mutation_id null, created_at

discord_links
  id, user_id, discord_user_id, linked_at, revoked_at null
  privacy_mode enum: full | fuzzy | anomaly_only | hidden

notification_preferences
  id, user_id, event_kind, channels text[]  -- ['push','discord']
  enabled, cooldown_minutes, quiet_hours jsonb

notification_log（去重依據）
  id, user_id, event_kind, dedup_key, channel, sent_at

ai_settings（M6 BYOK；一使用者一列）
  user_id (PK)
  enabled boolean
  base_url text   -- OpenAI 相容 chat completions 端點（自架/Workers AI/OpenRouter 通用）
  model text
  api_key_encrypted text null  -- 應用層 AES-256-GCM（domain 派生金鑰），null=免 key 的本機模型
```

匯率用 `numeric` 而非整數：匯率是**比率**不是金額；所有「金額 × 匯率」運算在 domain money module 內完成並立即捨入回整數最小單位。

## 6. 邊界規則

- **結帳日在月底**：`statement_day=31` 在小月取當月最後一天（domain 統一實作 `clampToMonthEnd`）。
- **餘額**：任何帳戶餘額 = 其 journal_lines 總和（物化視圖或快取皆可，但真相是加總）。
- **删除**：軟刪除的 transaction，其 journal entry 一併標記；餘額計算排除 deleted。
- **statement_items 不可變**：帳單是外部事實，修正發生在帳本側；重匯建立新 statement 版本。

## 7. 核心 vs 可延後

- **核心（沒有就不成立）**：accounts、credit_cards、journal_*、transactions、transaction_links、audit_logs、recurring_rules、expected_transactions。
- **可延後**：account_groups（純顯示）、merchant_aliases（M3 有基本版即可）、jobs（M3）、上櫃／其他國家行情 provider、notification_log（M5）。台股 TWSE 與美股 Finnhub provider 已落地（ADR-008）。
- **明確不建**：預算表、財務評分表、任何分析快取表（違反產品原則的功能連表都不要有）。
