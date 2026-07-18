# INVESTMENT_MODEL — 投資與資產模型

相關 ADR：ADR-001（複式帳本）、ADR-008（價格來源）。帳務與估值實作在 `packages/domain`、`packages/database`，provider 介接在 `apps/api/src/market-data.ts`。表定義見 `docs/DATA_MODEL.md` §5。

## 1. 原則

- **投資買賣不是消費/收入**：買入＝資產轉換（現金→投資資產），賣出＝資產轉換＋已實現損益；只有股息、手續費、稅走收支分類（TXN-4、INV-4）。
- 交易與匯率現階段由使用者維護；**標的價格由 provider 自動抓取**，使用者不手抄報價。每筆價格仍記錄 `as_of` 與來源並在過期時提醒（ADR-008）。
- 未實現損益是**推導值**（市值 − 成本），不入帳本；帳本只記成本基礎。

## 2. 結構

```text
investment_accounts（券商）
  ├─ settlement_account_id → 交割現金帳戶（accounts, subtype=brokerage_settlement）
  └─ asset_account_id     → 投資資產帳戶（accounts, subtype=investment_asset）——記成本基礎
holdings（該券商的每檔持倉：數量 + 每股平均成本）
securities（代號主檔：TW/US、幣別、stock/etf）
market_prices（價格快照：price, as_of, source）
exchange_rates（匯率快照：base/quote, rate, as_of, source）
```

## 3. 交易的帳務處理

| 動作 | Journal lines | Holdings 變化 |
|---|---|---|
| 入金 5,000 | `交割帳戶 +5,000`；`銀行 −5,000`（轉帳） | — |
| 登記開始記帳前已有持倉 5,000 | `投資資產 +5,000`；`期初權益 −5,000`（adjustment） | 建立期初數量與成本；**不扣交割現金** |
| 買入 ETF 5,000 + 手續費 20 | `投資資產 +5,000`；`手續費(expense) +20`；`交割帳戶 −5,020` | 數量↑、平均成本重算 |
| 賣出（成本 5,000，成交 5,600，費 25） | `交割帳戶 +5,575`；`投資資產 −5,000`；`已實現損益(income) +600`；`手續費 +25` | 數量↓（平均成本法） |
| 股息 120（稅 12） | `交割帳戶 +108`；`稅(expense) +12`；`股息(income) +120` | — |

- 成本法：**平均成本法**（台股實務慣例、計算簡單）。個別批次法（lot tracking）延後——單人手動維護不值得這個複雜度。
- 每個投資帳戶只有一個幣別；標的幣別必須與該帳戶的交割／投資資產帳戶一致。美股帳戶以 USD 建立，`VT` 的市場填 `US`、報價幣別填 `USD`；同一券商若同時有臺幣與美元部位，建立兩個同券商、不同幣別的投資帳戶。跨幣別入金走 DATA_MODEL I-3 的 fx_pair 規則。
- 顯示時必須把帳戶市場語意與幣別帶進名稱：臺灣券商的 TWD 帳戶標為「台股」，USD／JPY 等外幣帳戶標為「複委託 + 幣別」；非臺灣券商的外幣帳戶標為「外幣投資 + 幣別」。不可只顯示同一個券商名稱，讓同券商的台股與複委託帳戶無法區分。
- 標的代號、名稱、市場、幣別與類型可編輯。若改幣別會重新解讀既有成本或歷史報價，domain service 必須拒絕，並引導在正確幣別投資帳戶重新登記；不得靜默改壞估值。
- 「登記現有持倉」與「買入」是不同事實：前者只建立期初部位，後者才代表本帳本期間內真的從交割戶付款。不得用買入代替期初持倉，否則會產生看不見的交割戶負餘額並低估淨資產。
- **實作落差（2026-07-18）**：`invest_buy`/`invest_sell` 的 posting rule（`packages/domain/src/posting.ts`）是單純的兩條線（交割 ↔ 投資資產），買入手續費目前併入總金額計入成本基礎，不會像上表拆出獨立的手續費 expense line；要單獨追蹤手續費，可另外記一筆 `fee` 交易（交割帳戶 −n）。是否要讓 `invest_buy` 支援拆出手續費線，待作者實際使用後再評估（見 `docs/OPEN_QUESTIONS.md`）。

## 4. 估值與淨資產

```text
持倉市值 = quantity × 最新 market_price（同幣別）
外幣市值 → 基準貨幣：× 最新 exchange_rate
淨資產 = Σ資產帳戶餘額 + Σ持倉市值（換算基準貨幣） − Σ負債帳戶餘額
       （投資資產帳戶的「成本」不重複計入——一覽用市值取代成本）
```

基準貨幣：使用者設定，預設 TWD。

首頁一覽（INV-5）欄位：可用現金、銀行存款、投資市值、信用卡負債、其他負債、淨資產、未來 30 天預計流入/流出（來自 expected_transactions + 帳單 due）、**每個數字的資料時間**。

## 5. 資料新鮮度

- 每個價格/匯率帶 `as_of` + `source`；一覽顯示「最後更新：n 天前」。provider 寫入同樣留下 audit log。
- 過期門檻（預設 7 天，可調）→ 觸發提醒（M5 起走 Discord/Push）。
- 自動報價：`TW/TWD` 使用 TWSE OpenAPI；`US/USD` 使用 Finnhub Quote API。由使用者在投資頁觸發單次更新，不接受手動價格欄位（ADR-008）。
- 美股未設定 `OKANE_DOKOITTA_FINNHUB_TOKEN`、provider 無資料或暫時失敗時，保留最後成功快照並顯示可操作錯誤；不得把失敗偽裝成價格 0。

## 6. 明確不做

- 報酬率排名、績效競賽、對大盤比較（產品原則）
- 自動下單、券商 API 介接
- 即時行情推送
- 選擇權/期貨/加密貨幣（未在作者需求內；資料模型的 securities.kind 可未來擴充）
