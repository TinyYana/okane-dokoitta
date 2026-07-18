# TESTING — 測試策略

工具：Vitest（單元/整合）、Playwright（E2E）、GitHub Actions（CI）。原則：**測試優先順序跟著產品優先級走——資料正確性的測試永遠最先寫、最不可刪。**

## 1. 測試層級

### L1 Domain 單元測試（最高優先，`packages/domain`）

- money：整數運算、各幣別指數、分期/匯率換算的捨入——含極值與負數。
- posting rules：每種交易類型 → 預期 journal lines；**不變量 I-1～I-4 的違反案例必須被拒絕**。
- 特別釘死（每條都是曾在需求中明文禁止的錯誤）：
  - 信用卡繳款不產生 expense line
  - 投資買入不產生 expense line
  - 退款必須 link 原交易
  - entry lines 每幣別總和為 0
- 狀態機：合法/非法轉移矩陣。
- 日期：月底結帳日 clamp、時區邊界（台北 23:50 的消費落在哪一天）。

### L2 引擎測試（`packages/audit-engine`、`packages/sync`、`packages/importers`）

- matching：每條規則獨立 fixture（給定 pair → 預期 reasoning codes + 分數區間）。
- 差額求解：每個錯誤型（§AUDIT_ENGINE 6）至少一個 fixture + 一個「無法解釋」案例 + n=300 效能上限測試。
- importer：每個 importer ≥2 個去識別化 fixture 與預期 NormalizedStatement（新 importer 的 DoD，IMPORTER §6）。
- sync 協議：冪等（同 mutationId 重送）、版本衝突、刪改衝突矩陣（SYNC §3.5）——純邏輯層測試。

### L3 API 整合測試（`apps/api`，對真實 PostgreSQL）

- 對 docker compose 起的 Postgres 跑；每測試案例獨立 schema/transaction rollback。
- 覆蓋：auth 流程、mutation 端點的冪等與衝突（真 DB 版）、change feed 游標、audit log 寫入驗證（每個寫入端點打完查 audit_logs 必有記錄）、匯出完整性（建資料→匯出→欄位齊全）。

### L4 E2E（Playwright，關鍵流程）

- 記一筆帳→出現在清單與餘額
- **離線記帳→恢復連線→同步成功**（Playwright offline 模擬）
- 雙 context 模擬雙裝置衝突→衝突 UI 出現
- 匯入 CSV→audit session→確認 patch→帳本更新
- PWA 安裝性（manifest/SW 煙霧測試）

E2E 只保護關鍵路徑，不追覆蓋率——變動快的 UI 細節交給 L1–L3。

## 2. CI（GitHub Actions）

```text
PR → lint + typecheck + L1 + L2（無外部依賴，快）
   → L3（service container: postgres）
main → 加跑 L4（headless）＋ build image
release → 加跑備份還原演練（DEPLOYMENT §4）
```

紅燈不得合併（AGENTS §8）。

## 3. 測試資料紀律

- Fixture 一律去識別化：假名、假末四碼；**真實個資與真實帳單不得進 repo**（IMPORTER §6）。
- 金額 fixture 刻意包含：0、1、負數、TWD 大額（>2^31，驗 bigint 路徑）、USD 有小數位幣別。
- 不 mock domain——domain 是純函式，直接測真的；mock 只用於外部邊界（Discord API、AI provider、時鐘）。
- 時間相關測試注入 clock，不用真實 `Date.now()`。
