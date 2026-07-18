# DISCORD_INTEGRATION — Discord 整合

相關 ADR：ADR-005（interactions endpoint 架構）。實作：`apps/discord` + `packages/notifications`。

Discord 是第一級整合。但它是**遙控器與通知管道**，不是第二個完整客戶端——複雜操作導向 PWA。

## 1. 安全原則（恆常，違反即 bug）

1. 財務資訊只出現在 **DM** 或 **ephemeral response**；公開頻道零洩漏。指令在公開頻道被呼叫 → 一律 ephemeral 回覆，內容遵守使用者的隱私模式。
2. 帳號連結走 OAuth + 一次性驗證（§3），可隨時撤銷。
3. 所有會修改資料的操作需要二次確認（Discord button）；高風險操作（刪除、批次修改、繳款標記）**不提供** Discord 入口。
4. Bot 不直接連資料庫；所有操作經正式 API 與 domain service（與 PWA 同一條路，同樣寫 audit log，actor=discord）。
5. Discord bot token、使用者 OAuth token 應用層加密儲存；Discord 身分與帳本權限的對應只存在 server 端 `discord_links`。

## 2. 架構

```text
Discord → (slash command / button) → HTTPS POST → apps/discord (interactions endpoint)
   ├─ Ed25519 簽章驗證（Discord 公鑰）
   ├─ discord_user_id → discord_links → user_id（未連結→引導連結）
   └─ 呼叫 api 層 service → domain → 回 ephemeral/DM

worker（排程）→ 事件觸發 → packages/notifications（去重/冷卻/隱私模式）→ Discord REST API 發 DM
```

無 gateway 長連線（ADR-005）。

## 3. 帳號連結流程

```text
PWA 設定頁 → 「連結 Discord」→ Discord OAuth2 (identify scope)
→ callback 綁定 discord_user_id ↔ user_id → discord_links 建立
→ PWA 顯示已連結 + 撤銷按鈕；撤銷→ revoked_at，bot 立即拒答
```

反向（從 Discord 端發起 `/finance link`）：bot 回一次性連結 URL（短效 token）→ 使用者在已登入的 PWA 完成綁定。**絕不在 Discord 內輸入密碼。**

## 4. Slash commands（M5 第一批）

| 指令 | 內容 | 風險 | 評估 |
|---|---|---|---|
| `/finance status` | 總覽摘要（依隱私模式） | 讀 | ✅ 高價值 |
| `/finance networth` | 淨資產 + 資料時間 | 讀 | ✅ |
| `/finance upcoming` | 未來 14 天預計扣款/繳款 | 讀 | ✅ 最高頻使用 |
| `/finance cards` | 各卡結帳/繳款日與本期金額 | 讀 | ✅ |
| `/finance pending` | 未確認交易/預計交易 | 讀 | ✅ |
| `/finance audit-status` | 最近 audit session 狀態與差額 | 讀 | ✅ |
| `/finance reminders` | 我的提醒設定總覽 | 讀 | ✅ |
| `/finance add 120 午餐` | 建立**草稿**交易（status=draft, source=discord_draft, needs_review），回 PWA 連結 | 低風險寫 | ✅ 只到草稿，不入帳本正式狀態 |
| `/finance confirm` | 列出待確認預計交易 → 按鈕逐筆確認（二次確認） | 低風險寫 | ✅ 限定 expected→confirmed 單一轉移 |

不提供：刪除、修改金額、繳款標記、匯出——導向 PWA。

## 5. 事件通知（M5）

| 事件 | 預設時機 | dedup key |
|---|---|---|
| 信用卡即將結帳 | 結帳日前 2 天 | card+cycle |
| 信用卡即將扣款/繳款截止 | due 前 3 天、前 1 天 | card+cycle+offset |
| 扣款帳戶預估餘額不足 | autopay 前 3 天起每日 | card+cycle |
| 固定訂閱即將扣款 | 前 1 天 | expected_txn |
| 預計交易逾期未確認 | 逾期當天 + 每 3 天 | expected_txn |
| 新帳單等待審計 | 匯入完成時 | statement |
| 審計發現差額 / 審計完成 | session 完成時 | session |
| 投資價格過期 | 超過門檻，每週最多 1 次 | security |
| 雲同步失敗 / 備份失敗 | 發生時，冷卻 6h | kind+day |

規則：

- 每則通知先查 `notification_log` 的 dedup_key，重複不發。
- 每事件類型有 `cooldown_minutes` 與開關（`notification_preferences`），支援 quiet hours。
- 通知內容遵守隱私模式（§6）。
- 通道可選：Discord DM、Web Push、或兩者。

## 6. 隱私模式（每使用者設定，套用於所有 Discord 輸出）

| 模式 | `/finance networth` 範例輸出 |
|---|---|
| `full` | 淨資產 NT$ 1,234,567（更新於 2 小時前） |
| `fuzzy` | 淨資產約 NT$ 120 萬（更新於 2 小時前） |
| `anomaly_only` | 一切正常，沒有需要注意的差異 ✅／有 2 件事需要你看一下 |
| `hidden` | 金額已隱藏，請到 PWA 查看 |

模糊化規則（fuzzy）在 domain 統一實作（有效位數 2 位），所有指令與通知共用。

## 7. 語氣

通知與回覆遵守 `docs/PRODUCT_VISION.md` §5：可愛、不說教。例：

> 💳 彼岸花信用卡後天（7/19）結帳，本期目前 NT$ 8,420。
> 🔍 帳單和帳本差 1,205 元，我找到兩個可能的原因，到 PWA 看看？
