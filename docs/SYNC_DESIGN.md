# SYNC_DESIGN — 雲端同步協議

相關 ADR：ADR-002。實作 package：`packages/sync`；表定義見 `docs/DATA_MODEL.md` §5。

## 1. 需求回顧

多裝置、本機快取、離線操作佇列、恢復連線後同步、冪等 mutation、軟刪除、版本控制、衝突偵測、完整 audit log、裝置識別、同步狀態顯示、手動重新同步、匯出與還原。

**底線：財務資料的衝突必須被看見並由使用者解決，任何靜默覆寫或靜默合併都是 bug。**

## 2. 架構比較

| 面向 | ① Server-authoritative + mirror + outbox | ② Local-first event log | ③ CRDT | ④ 僅線上 |
|---|---|---|---|---|
| 真相所在 | Server（Postgres） | 事件流（各端重放） | 各端收斂狀態 | Server |
| 離線寫入 | ✅ outbox 排隊 | ✅ | ✅ | ❌ |
| 衝突語意 | 顯式偵測、人工解決 ✅ | 重放順序決定，需自訂衝突層 | **自動合併＝捏造帳務事實 ❌** | 無衝突（也無離線） |
| 可追蹤性 | audit_logs + sync_mutations ✅ | 事件流天然 ✅ | 弱 | ✅ |
| 實作複雜度 | 中 | 高（schema 演進、重放、快照） | 高 | 低 |
| 自架/備份 | pg_dump 即備份 ✅ | 需事件流+快照策略 | 複雜 | ✅ |
| 適合帳務？ | ✅ | 過度工程（單人低頻寫入） | ❌ 語意錯誤 | ❌ 缺硬需求 |

**結論**：採 ①。②的主要好處（完整歷史）由 `audit_logs` + `sync_mutations` 以低得多的成本取得。③明確拒絕：兩台裝置把同一筆交易改成不同金額時，正確行為是「請使用者選」，不是自動合併。

## 3. 協議設計

### 3.1 Mutation envelope（上行）

Client 對任何寫入產生：

```ts
type SyncMutation = {
  mutationId: string;      // UUIDv7，client 產生 —— 冪等鍵
  deviceId: string;
  entity: string;          // 'transactions' | 'accounts' | ...
  entityId: string;        // UUIDv7，create 時也由 client 產生
  op: 'create' | 'update' | 'delete';   // delete = 軟刪除
  baseVersion: number | null;           // update/delete 必帶：client 所見版本
  payload: Record<string, unknown>;     // Zod 驗證後交 domain service
  clientAt: string;        // ISO 8601（僅記錄用，不參與衝突判定）
};
```

### 3.2 Server 處理規則

1. **冪等**：`mutation_id` 已存在 → 直接回傳首次結果，不重複套用。
2. **驗證**：Zod schema → domain service 驗證（帳務不變量、posting rules）。失敗 → `rejected_invalid`。
3. **版本檢查**：`update/delete` 時 `baseVersion !== current.version` → `rejected_conflict`，**不套用**。
4. 套用成功：row `version + 1`，寫 `change_log`（全域遞增 `seq`）、`sync_mutations`、`audit_logs`——同一個 DB transaction 內完成。
5. 套用順序：per-device FIFO（client 依序送出 outbox；server 依到達順序處理）。

### 3.3 Change feed（下行）

```text
GET /sync/changes?since=<seq>&limit=200
→ { changes: [{ seq, entity, entityId, version, snapshot }], nextSince }
```

- Client 每裝置保存 cursor（最後處理的 `seq`）。
- `snapshot` 是該實體當前完整狀態（含 `deleted_at`）——非 diff，簡化 client 套用邏輯。
- 首次同步／還原＝從 `seq=0` 拉全量。

### 3.4 Client 端（PWA）

```text
UI 寫入 → 立即寫 IndexedDB mirror（樂觀）＋ outbox 排隊
       → 線上：即刻 flush outbox；離線：等 reconnect
拉取   → 前景輪詢 + 操作後即拉；套用 change feed 到 mirror
```

- Outbox 是 FIFO；flush 逐筆送出，成功才移除。
- 收到 `rejected_conflict`：該 mutation 移入 conflict 佇列，UI 顯示「這筆有衝突」，呈現**兩個版本**（本機修改 vs server 現況）供使用者選擇或手動合併；解決後以新 mutation 重送（帶最新 baseVersion）。
- 收到 `rejected_invalid`：顯示錯誤，該筆退回草稿，不阻塞後續佇列（除非後續 mutation 依賴同一 entity —— 同 entity 的後續 mutation 一併退回）。
- 樂觀寫入與 server 結果不一致時，以 change feed 的 snapshot 為準覆蓋 mirror。
- IndexedDB 與瀏覽器裝置 ID 都以已登入的 `user_id` 分區。登出即清除目前 user context；不同帳號不得共用 cache、mirror、outbox、conflict、draft 或 device ID。從早期未分區格式升級時，舊的全域資料庫直接移除，避免把前一位使用者的資料帶入新帳號。

### 3.5 刪除與衝突矩陣

| 情境 | 行為 |
|---|---|
| A 改、B 改（同 entity） | 後到者 `rejected_conflict` → 人工解決 |
| A 刪、B 改 | 後到者 conflict → 人工解決（刪除不自動贏） |
| A 刪、B 刪 | 第二個 delete 冪等成功（結果相同） |
| A 建、B 建（不同 entityId） | 各自成功；重複記帳交給審計引擎的 duplicate 偵測，不在同步層猜 |

### 3.6 同步狀態 UI（PWA-8）

每筆資料/全域顯示：`synced` / `queued(n)` / `conflict(n)` / `offline`。提供手動「立即同步」。

## 4. 裝置管理

- 裝置首次登入註冊 `sync_devices`（名稱、平台）；使用者可列出、改名、撤銷。
- 撤銷＝該裝置 session 失效 + 後續 mutation 拒收；本機快取由 client 清除（無法遠端保證——寫入威脅模型，見 SECURITY）。

## 5. 匯出與還原

- **匯出**：全量 JSON（所有使用者資料表，含 audit 歷史、規則、別名、Discord 設定）+ 每實體 CSV。格式帶 `formatVersion`。M1 就要有（資料所有權原則）。
- **救災還原**：`pnpm backup` 將 `pg_dump` 與 `DATA_DIR` 打包後以 AES-256-GCM 加密；`pnpm restore` 需要明確的 `--confirm-restore` 才會呼叫 `pg_restore`。應用層 JSON 是可攜匯出，不拿來取代含 migration／附件的實例備份。

## 6. 明確不做

- 不做 partial sync / 選擇性同步（單人資料量小，全量鏡像）。
- 不做 field-level merge——衝突以整筆呈現。
- 不做 P2P 裝置直連同步。
