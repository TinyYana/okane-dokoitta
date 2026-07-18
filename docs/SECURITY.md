# SECURITY — 威脅模型與安全需求

相關 ADR：ADR-003（加密，accepted）。本文件的「最低安全需求」（§5）是驗收條件，不是建議。

## 1. 威脅模型

**保護的資產**：帳務資料（交易、餘額、商家）、帳單原始檔、投資持倉、session 憑證、Discord token、備份檔。

**明確不存在的資產**（設計上排除，最有效的防護）：網銀/券商密碼、完整信用卡號（只存末四碼）、CVV。

| 對手 | 情境 | 主要防線 |
|---|---|---|
| 網路攻擊者 | 公開 HTTPS 端點掃描、撞庫、CSRF/XSS | TLS、Passkey、rate limit、CSP、CSRF 防護 |
| 竊取裝置者 | 拿到手機/筆電 | OS 鎖 + session 撤銷 + 裝置撤銷；IndexedDB 明文是已知殘餘風險（§7） |
| 惡意帳單檔 | 構造 PDF/CSV 攻擊解析器 | 解析 timeout/記憶體上限、只抽文字層、CSV 公式防護（IMPORTER §5） |
| 被盜的 Discord 帳號 | 冒用使用者查詢 | 隱私模式預設非 full、高風險操作不經 Discord、可撤銷連結 |
| 同實例的其他使用者 | 水平越權（IDOR）、猜他人資源 ID | 所有查詢以 `user_id` 界定（AGENTS §7）、跨使用者 IDOR 整合測試（M2）、per-user rate limit |
| 實例管理者（多使用者實例） | 讀取其他使用者的帳務資料 | 靜態加密 + 檔案/token 應用層加密；帳務欄位可讀是 ADR-003 的已知取捨（自架文件知情揭露）；未來 opt-in 使用者主密鑰加密 |
| 主機/託管方 | 讀取磁碟或 DB | 靜態加密 + 應用層加密敏感檔案；完整防護需 E2EE（§3 取捨） |
| 備份外洩 | 備份檔流出 | 備份一律加密（age/GPG），金鑰不與備份同放 |

## 2. 信任邊界

```text
[瀏覽器 PWA] ──TLS──► [api] ──► [domain] ──► [PostgreSQL]
[Discord] ──簽章驗證──► [discord app] ──► api（不直連 DB）
[上傳檔案] ──視為不可信輸入──► [worker 解析（受限）]
[AI provider（M6, BYOK）] ──只收去識別化的必要欄位、只回建議──► proposed_patches
```

## 3. 加密層級比較（ADR-003 詳析）

| 方案 | 內容 | 自動化能力 | 防主機方 | 複雜度 |
|---|---|---|---|---|
| ① 僅 TLS + 靜態加密 | DB/磁碟加密 | 全部保留 | ❌ | 低 |
| ② 應用層欄位加密（server 金鑰） | 敏感欄位 AES，金鑰在 server env | 全部保留 | ❌（金鑰同在 server） | 中 |
| ③ 使用者主密鑰 | 指定欄位只有 client 能解 | 部分喪失 | 部分 ✅ | 高 |
| ④ 完整 E2EE | server 全盲 | **喪失**：排程提醒、Discord 通知、伺服器解析、配對全做不了或退化為 client 端 | ✅ | 最高 |
| ⑤ 混合式（推薦） | ①+②：TLS + 靜態加密 + 應用層加密「檔案與 token」 | 全部保留 | 檔案與 token ✅，帳務欄位 ❌ | 中 |

**E2EE 衝突分析**（為什麼不選 ④）：

- 伺服器排程需要讀 `due_date`、`amount`、帳戶餘額才能算「繳款前餘額不足」——E2EE 下 server 看不到。
- Discord 通知由 server 組裝內容——E2EE 下只能發「有事情發生」的空殼通知。
- 伺服器端帳單解析與配對需要讀明細——E2EE 下全部搬到 client，離線/多裝置一致性大幅複雜化。
- 自架情境中 server 就是使用者自己的機器，E2EE 的邊際收益低。

**欄位敏感度分類**（⑤ 的具體邊界）：

| 資料 | server 可見？ | 理由 |
|---|---|---|
| 金額、日期、帳戶結構、狀態 | ✅ 明文（受靜態加密） | 排程、配對、通知的必要輸入 |
| 商家名稱 | ✅ 明文 | 配對與 alias 的必要輸入 |
| 自由文字備註 | ✅ 明文（可未來納入 ③ 選用加密） | 非自動化必要，候選加密欄位 |
| 帳單原始檔 | 🔒 應用層加密（server 金鑰） | 檔案含最完整個資，解析後即非必要 |
| Discord/OAuth token、Push 憑證 | 🔒 應用層加密 | 憑證類 |
| 密碼/Passkey | Passkey 公鑰；備援密碼 argon2id | 標準做法 |

**已定案**（2026-07-17，ADR-003 accepted）：驗收基準是「其他使用者看不到＋整體低外洩風險」，不要求 E2EE。使用者間隔離是硬需求（無取捨空間）；管理者對使用者的可讀性是⑤的已知取捨（作者核可），須在自架文件知情揭露。opt-in 使用者主密鑰加密（③）為未來可選強化（備註 + 帳單原始檔優先），非承諾項；官方託管上線前重審。

## 4. 認證與 Session

- **Passkey（WebAuthn）為主要登入**；註冊時產生一組一次性 recovery codes。可選 TOTP 作為第二因素/備援（M2）。
- Session：HttpOnly + Secure + SameSite=Lax cookie；server 端 session 表，可逐一撤銷；閒置與絕對過期。
- 登入通知（新裝置登入 → Discord/Push，M5）。
- Rate limiting：登入、匯入、API 全域三層。

## 5. 最低安全需求清單（驗收條件）

| 需求 | 里程碑 |
|---|---|
| HTTPS（自架文件含反向代理 TLS 設定） | M1 |
| Secure/HttpOnly/SameSite cookie；CSRF 防護（SameSite + token） | M1 |
| CSP（禁 inline script；PWA 相容設定） | M1 |
| Rate limiting | M1 |
| Secrets 只在 env；`.env.example` 只有 key；repo 掃描不到 secret | M1 |
| DB 最小權限（app 帳號無 DDL；migration 另一帳號） | M1 |
| 敏感欄位 log redaction（金額、token、session id 不進一般 log） | M1 |
| Audit log 全寫入路徑覆蓋 | M1 |
| 軟刪除 | M1 |
| Passkey + recovery codes；可選 TOTP | M2 |
| Session 管理 UI、裝置撤銷 | M2 |
| 所有查詢/寫入以 `user_id` 界定範圍（單人期亦然） | M1 |
| 跨使用者隔離整合測試（每個資料端點的 IDOR 案例） | M2 |
| 備份加密 + **還原測試**（每次 release 前跑一次還原演練） | M2 |
| 登入通知 | M5 |
| Discord link 撤銷 | M5 |
| 上傳檔案生命週期（§6）＋解析資源限制 | M3 |
| 禁止儲存網銀/券商密碼與完整卡號（schema 層就不存在欄位） | 恆常 |

## 6. 上傳檔案生命週期

```text
上傳 → 加密落地（storage_path）→ 解析 → statement_items.raw 保留結構化內容
→ 原始檔預設保留 90 天（retain_until，可設定）→ worker 定期 purge → status=purged
→ 使用者可隨時手動刪除原始檔（解析結果保留）
```

## 7. 已知殘餘風險（誠實列出）

- IndexedDB 鏡像在裝置上未加密——依賴 OS 層防護（FileVault/BitLocker/裝置鎖）。文件明示。
- 方案⑤下，自架主機被完全入侵＝帳務資料可讀。緩解：最小攻擊面（單容器、無多餘服務）、更新策略。
- Discord DM 內容經過 Discord 伺服器——隱私模式讓使用者自行決定暴露程度。
