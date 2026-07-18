# HANDOFF — okane-dokoitta

- 最後更新：2026-07-18（AI 審計整合、來源保留；撤回 CI 自動部署、gitignore 補洞）

## 本輪修正：撤回 Cloudflare CI 自動部署

- 上一輪在 `.github/workflows/ci.yml` 加了 push-to-main 即 `wrangler deploy` 的 step，並在 `docs/DEPLOYMENT.md` 補了對應章節。作者部署要自己事後設定，本輪整段撤掉：CI 只留 lint/typecheck/test/build（`concurrency` 取消重複 run 的設定保留，與部署無關），`DEPLOYMENT.md` 章節編號改回原本 7 節，`HANDOFF.md` 對應段落一併移除。
- `.gitignore` 補洞：`.dev-data.bak*/` 改成 `.dev-data.*/`（涵蓋當時清資料時產生的 `.dev-data.corrupt-0718/`），新增 `.playwright-cli/`（本機 Playwright CLI 快取，之前沒被忽略）。

## 本輪新增：AI 審計整合

- **AI 不再像被拔掉**：對帳首頁與 session 在 AI 未啟用、設定載入中或設定載入失敗時都顯示明確狀態；未啟用／失敗可直接前往設定，不再把錯誤吞掉後整段隱藏。
- **AI 整理保留來源**：帳單原文與 AI 整理稿分開；畫面可比較原文或捨棄整理稿。送出後 importer 解析使用者確認的整理稿，但 R2／本機加密檔、size 與 SHA-256 都以原始來源為準；statement item metadata 標記 `inputOrigin=ai_confirmed`。
- **Session 級 AI review**：新增 `POST /api/ai/review-session`。模型只收到必要候選事實，回覆經 Zod 驗證；不存在或重複的 candidate ID 會被剔除。結果只產生繁中摘要與畫面上的人工複核順序，不改 rule score、patch、decision 或帳本。單次上限 200 項，超過部分保留 rule 順序。
- **仍維持 proposal-only**：單筆 `/api/ai/explain`、整份 review 與整理稿都不直接寫帳；持久化 merchant alias 與歷史型 `PairScoreContext` 尚未實作，文件已改成誠實現況。

### 本輪實際驗證

- `pnpm.cmd --filter @okane-dokoitta/api test -- m6.test.ts`：因 Vitest 參數行為實際跑 API 全套，11 files／93 tests 全過；M6 為 6/6，新增驗證原文 SHA-256、AI lineage、session review、幻覺 ID 過濾。
- schemas、api、web 三個 workspace `typecheck`：全過。
- `git diff --check`：通過。
- 未執行真實 AI provider 或 production migration。

## 本輪完成範圍

- **明細篩選**：「全部帳戶」只列資產與負債帳戶，不再把收入／支出分類（項目）混進帳戶篩選。
- **AI 端點相容性**：設定同時接受 API 根路徑與完整 `/chat/completions/` URL，不再重複拼接路徑；上游非 2xx 回應會保留限長的 error message。provider 429 現在以 HTTP 429／`AI_RATE_LIMITED` 回傳並轉送 `Retry-After`，不再誤包成 502，也不自動重送。`google/gemma-4-31b-it:free` 已於 2026-07-18 透過 OpenRouter models API 確認存在，未改寫使用者模型設定。
- **AI 解釋序列化**：送往模型的 statement item 金額改為字串，不再因 `bigint` 交給 `JSON.stringify` 而在請求送出前回 502；金額仍未轉為浮點數。
- **帳務審計可讀性**：審計明細改為先顯示白話結論與待確認數，再逐筆顯示商家、日期、帳單行號、格式化金額、差異類型與判斷原因；`MISSING_IN_LEDGER` 等機器代碼與 evidence 收進可展開的「技術證據」。0% 不再冒充可信度，無候選時改寫成「沒有可信配對」；按鈕明示「套用配對」或「保留未解」，並說明保留未解不會新增／修改帳本。仍有待確認項目時，封存按鈕會停用並顯示剩餘數量。
- **帳單匯入即補記入口（Q21 選項 b）**：`missing_in_ledger` 的消費／手續費／現金回饋會產生 `create_transaction` patch；先採同商家歷史分類，未知消費歸「其他支出」並標 `needsReview`。審計頁可逐筆改分類或批次加入；每筆各自經 domain posting、冪等 mutation、patch actor audit log、change feed，再綁回 statement item。退款缺原交易仍只保留未解。
- **付款帳戶邊界**：快速記帳的「從哪裡付」排除 `brokerage_settlement` 與 `investment_asset`，一般消費不再把投資帳戶當可刷卡／付款來源；投資買賣繼續走專用投資流程。
- **本機啟動預設**：目前開發資料使用 PGlite，因此根目錄 `pnpm dev` 已改為啟動 watch 模式的 PGlite API + Vite；PostgreSQL 版保留為 API workspace 的 `dev:postgres`，不再讓日常開發誤撞 pending PostgreSQL migration。
- **Agent 伺服器收尾規則**：根目錄 `AGENTS.md` 已新增硬性規則；Agent 為驗證啟動的本機伺服器、watcher 或背景程序，除非使用者明確要求保留，必須在回報前關閉並確認相關 port／process 已停止。本輪已終止先前留下的 `pnpm dev`，並確認 3000、5173 均未監聽。
- **500 診斷邊界**：接手既有 `#/audit` 分頁後頁面仍完整顯示，Browser console 沒有保留該筆 500，Performance resource entries 也沒有可還原的失敗 URL，因此當時未把未知請求臆測成已修正。靜態反查顯示審計列表會呼叫 `/api/accounts`、`/api/audit/sessions`、`/api/ai/settings`；既有頁面資料證明前兩者曾成功。當時 M6 explain mock 的 502 後續已定位為 `bigint` 序列化問題並修正，本輪 targeted M6 已 6/6 通過。直接讀既有 PGlite 逐端點診斷的 inline `tsx` 指令曾因 Windows quoting／執行檔解析連續失敗兩次而依規則停止重試。
- **投資帳戶辨識**：既有與新建帳戶在清單／詳情顯示「台股」「複委託 + 幣別」或「外幣投資 + 幣別」。選臺灣券商與 USD／JPY 時，新帳戶名稱自動帶出複委託，使用者手動改名後不會再被自動覆蓋。
- **本機 `.env`**：新增 `pnpm env:local`，以 Node `crypto.randomBytes` 補齊本機 Docker Compose 必要欄位；只填空值、不覆寫既有設定，也不產生或回顯 Finnhub／Discord／VAPID 等外部憑證。
- **Node 本機啟動**：`api dev` 與 `dev:lite` 現在透過 Node 原生 `--env-file-if-exists=../../.env` 載入根目錄 `.env`；修正 Vite `:5173` 代理匯入時 API 看不到 `FILE_KEY` 而回 503。`.dev.vars` 仍只供 Wrangler。
- **聯邦銀行帳單**：`union-bank-credit-card` importer 已接入 auto detect；一份多卡 CSV 建立一個銀行 `statement_group`，下掛每卡 statement／audit session。審計歷史先顯示銀行合併帳單，再展開卡片。回饋可配對 income-to-card，不冒充退款。
- **淨資產**：首頁不再忽略負資產餘額或證券；顯示可驗算的「資產 − 負債／負餘額 = 淨資產」。新增 `net-worth.ts` 純函式測試。
- **期初持倉**：「登記現有持倉」改走 adjustment，由期初權益平衡，不扣交割現金；真正的買入才扣款。
- **來源調整帳戶**：期初持倉不再因「期初餘額」帳戶缺失而失敗；若曾被軟刪除會自動復原，完全不存在則自動建立，兩條路徑都有 audit log 與 change feed。復原 UPDATE 明確帶 `user_id`；migration `0013_smiling_thaddeus_ross.sql` 以每使用者 partial unique index 加上 `ON CONFLICT` 讀回，避免並行建立兩個調整帳戶。
- **AI 連線**：測試連線可在尚未啟用時使用；先保存畫面草稿再測；啟用前驗證端點與模型；設定讀取錯誤不再被 UI 吞掉；可移除 API key。
- **標的／幣別**：投資帳戶清楚顯示幣別；新增與既有標的都有市場、報價幣別（TWD／USD／JPY）與類型欄位。標的代號、名稱、市場、幣別與類型可更新；若既有持倉或歷史報價會被錯誤重解讀，後端拒絕直接改幣別並給出修正指引。
- **自動報價**：移除手動輸入價格 UI。`TW/TWD` 由 TWSE OpenAPI 抓收盤價；`US/USD`（含 VT）由 Finnhub Quote API 抓取，token 只放 `OKANE_DOKOITTA_FINNHUB_TOKEN`。provider 快照寫入 `market_prices(source=provider)`、audit log 與 change feed。
- **手機 UI**：資產球手機放大為 76–104px，名稱與金額字級同步放大；球體依實際顆數等距排在 120px 軌道上，最多 6 顆也不互蓋；320px 超窄螢幕才以 viewport 動態把球收斂至最多 80px，360px 以上保留完整尺寸與核心間隙。「從哪裡付」與分類 chip 在手機單列橫向滑動，`sm` 以上才換行展開；底部 navbar 改為有圖示、安全區與當前狀態的浮動導覽島。
- **本機投資資料重置**：原 `.dev-data` 的 WAL checkpoint 已損壞；以 PostgreSQL 17.10 `pg_resetwal` 只修復備份副本後，清除 2 個投資帳戶、3 筆持倉、3 個標的、2 筆報價。清理前後銀行／信用卡均為 5、非投資帳戶均為 38。舊資料保留在 `apps/api/.dev-data.bak-corrupt-pre-reset-20260718-1944`；新 `.dev-data` 已切換並重啟 dev-lite（port 3000）。
- **文件／schema**：ADR-008 改為自動報價；新增 ADR-010、`statement_groups` additive migration `0012_handy_harpoon.sql`，以及 opening balance 唯一性 migration `0013_smiling_thaddeus_ross.sql`；DATA_MODEL、INVESTMENT_MODEL、IMPORTER_SYSTEM、PRODUCT_REQUIREMENTS、ROADMAP、DEPLOYMENT、SETUP_TUTORIAL、README 與 OPEN_QUESTIONS 已同步。

## 本輪實際驗證

- `.\apps\api\node_modules\.bin\vitest.cmd run apps/api/test/m6.test.ts --root .`：6/6 tests 通過，涵蓋完整 endpoint、500 訊息限長、429／`Retry-After`、BYOK key 不回傳，以及 extract → audit → explain；先前 explain 502 的根因是 `bigint` 無法 `JSON.stringify`，不是 fetch mock。
- `pnpm.cmd --filter @okane-dokoitta/api typecheck`、`pnpm.cmd --filter @okane-dokoitta/web typecheck`、`pnpm.cmd --filter @okane-dokoitta/schemas typecheck`：全部通過。
- `pnpm.cmd --filter @okane-dokoitta/web typecheck`：通過。
- `pnpm.cmd --filter @okane-dokoitta/web build`：通過（1866 modules、PWA precache 10 entries）。
- `pnpm.cmd lint`：0 errors；僅 `worker-configuration.d.ts` 2 個既有 generated warnings。
- 真實 Chrome 登入狀態讀取既有 2026-07-10 審計：桌面版可讀到結論、商家、日期、行號、金額、原因與決策後果；360px viewport `scrollWidth === clientWidth === 345`，無水平溢出，console 0 errors。驗證過程未接受或拒絕任何提案。
- `pnpm.cmd env:local`：首次補齊 11 個本機必要欄位；第二次回報未修改，確認不覆寫且可重跑。另以 Node 原生 env loader 驗證 `FILE_KEY` 已載入且長度有效；重啟 `dev:lite` 後 `/api/auth/status` 正常，API typecheck 通過，全程未回顯值。
- `apps/api/test/m3.test.ts`：9 tests 全過；新增驗證帳單缺漏建立待複核交易、statement linkage、patch actor audit log、動態差額歸零，以及信用卡回饋建立為 income 而非 refund。
- `pnpm.cmd --filter @okane-dokoitta/domain test -- dates.test.ts`：實際依 Vitest 參數行為跑完整 domain suite，7 files／93 tests 全過；新增 Asia/Taipei、America/New_York、Pacific/Kiritimati 民用日期轉時間點往返測試。
- `.\apps\api\node_modules\.bin\vitest.cmd run apps/web/test/net-worth.test.ts --root .`：2 tests 全過。
- database、api、web 三個 workspace `typecheck` 全過；web production build 成功（1866 modules、PWA precache 10 entries）。
- PGlite 測試 DB 已從 migration 0000 跑到 0013 並通過；本機 dev-lite 已在清理後資料庫上重新啟動，`/api/auth/status` 回覆正常。

## 未驗證／剩餘風險

- 真實 Chrome 驗證只讀取既有資料，未接受 patch、未匯入帳單、未新增投資帳戶，因此批次按鈕與新建交易的真實資料寫入證據來自 PGlite M3 整合測試，不是作者本機帳本。
- 尚未用作者原始聯邦 CSV 做新版 group 寫入的真實匯入驗收；原檔沒有複製進 repo。
- 尚未以真實 Finnhub token 對 VT 呼叫；自動測試使用 mock 回應。Cloudflare／Docker 部署後必須設定 secret 才能抓美股；台股不需要 token。
- 目前每個投資帳戶只有一個帳務幣別。同券商若有 TWD 與 USD 部位，要建立兩個同券商、不同幣別的投資帳戶；系統不會把已存在的 TWD 成本自動猜成 USD。
- USD → TWD 匯率仍由設定頁維護；缺匯率時淨資產會明確標記不完整，不會猜值。即時行情推播與背景高頻輪詢不在本輪範圍。
- 未以作者的真實 OpenRouter key 呼叫最終版本；自動測試使用 mock 429／500。使用者現場已證明完整 endpoint 能到達 OpenRouter 並取得 429，但修正後的 HTTP 429 與 `Retry-After` 呈現仍待瀏覽器重新測試。
- 真實 Chrome 已驗證桌面帳戶清單會把台股券商 TWD 帳戶顯示為「台股」、複委託 USD 帳戶顯示為「USD 複委託」；「從哪裡付」只列 5 個日常資產、4 張信用卡與錢包，沒有 3 個投資帳戶。360px 時帳戶與既有審計頁皆 `scrollWidth === clientWidth === 345`，頁面 console 0 errors。既有審計 session 建於本功能之前，所以仍顯示舊 `acknowledge_unresolved`，未拿真實帳本重匯入覆寫。

## 下一個可執行步驟

1. 在正確的 USD 投資帳戶編輯／重新登記 VT，市場填 `US`、幣別填 `USD`；不要把既有 TWD 成本直接改成美元。
2. 設定 `OKANE_DOKOITTA_FINNHUB_TOKEN` 後，在 VT 持倉按「取得自動報價」做真實驗收。
3. 用作者原始聯邦 CSV 跑一次真實匯入，確認銀行 group 與卡片子層級。

## 本輪新增（依作者 /goal 七項）

1. **「從哪裡付」沒顯示銀行——根因是資料不是程式**：實查 dev 資料庫（`.dev-data`），「Sny 數位帳戶」「實體存款戶」的 `institution` 都是 NULL（migration 0008 之前建立、沒人回填），顯示管線本身是通的。修法補可發現性：帳戶列表對缺銀行的帳戶顯示「哪家銀行？點進來補」accent 提示、明細頁加一鍵開啟編輯的補設定橫幅。**作者要做的**：到帳戶頁把兩個帳戶的銀行補上就會顯示。（信用卡本來就有發卡行、正常。）另外 dev:lite 供應的是 build 後的 dist——本輪已重新 build，直接 `dev:lite` 就是新版。
2. **定期定額＝圈存式（Q18 拍板落地）**：`recurring_rules` 加 `kind: invest_buy`＋investmentAccountId＋securityId（migration **0009**，additive）。到期先以預估金額圈存（重用 expected 管線→自動佔住 30 天預計流出），「週期」頁確認時填**實際成交金額＋股數**才入帳（invest_buy→平均成本法持倉→規則推進下期）。UI：新增規則的「週期支出／定期定額」切換、專用確認對話框；快速記帳頁的待確認清單遇到定期定額會導去週期頁。測試 `recurring-invest.test.ts` 3 個（拒絕缺欄位、圈存反映 30 天流出、確認全流程）。
3. **M6 AI 輔助（程式完成）**：`ai_settings` 表（migration **0010**）＝BYOK，每使用者一組 **OpenAI 相容端點**（baseUrl＋model＋key，key 用 sessionSecret 派生金鑰 AES-GCM 加密）——自架 Ollama/LM Studio、Cloudflare Workers AI（`…/accounts/<id>/ai/v1`）、OpenRouter 同一介面通吃，**伺服器完全不需要 AI 金鑰**（回應目標 6＋7：不用假 key，架設者/使用者自帶）。端點：`/api/ai/settings`、`/test`、`/extract-statement`（髒文字→generic-text 逐行格式，貼回匯入框走原管線＝欄位抽取＋商家正規化）、`/explain`（候選證據轉白話，只顯示不入庫）。UI：設定頁「AI 輔助」區塊、對帳頁「AI 幫我整理」與逐候選「AI 解釋這筆」。**候選排序刻意沒做**（規則分數夠用；要加從 PairScoreContext 接）。AI 停用時一切退回純規則（m6.test 驗證 409＋核心不受影響）。
4. **架設教學**：`docs/SETUP_TUTORIAL.md` 新手向手把手（Docker Compose、金鑰產生、HTTPS/Caddy、Discord Developer Portal 全流程、VAPID、AI 接法表、備份還原、升級、疑難排解）。補了缺口：`scripts/discord-register-commands.mjs`（slash 指令註冊工具，之前根本沒有）、docker-compose.yml 補傳 FILE_KEY/Discord/VAPID 變數（之前教了也不生效）、Dockerfile 把腳本帶進 image、`.env.example` 補 `OKANE_DOKOITTA_DB_PASSWORD`。
5. **提醒優先走 Discord**：notification-scheduler 改為 Discord 可用就只發 Discord，Web Push 降為「沒連結 Discord 時的備援」；設定頁文案同步。已知天花板（程式內註記）：Discord 單次投遞失敗不會 fallback 到推播。
6. **git 整理**：`docs/` 解除 ignore 入 git（已掃過無機密——只有教學裡的占位字）、HANDOFF 入 git、README 現況改寫成 M1–M6、`.dev-data.bak*/` 入 ignore、累積的 M2–M6 工作樹全部 commit。
7. 文件同步：ROADMAP（M6 實作現況）、DATA_MODEL（recurring kind 欄位＋ai_settings）、AUDIT_ENGINE §8（實作現況）、OPEN_QUESTIONS（Q18 移到已解決）、DEPLOYMENT（指向教學）。

## 本輪實際驗證

- `pnpm test` 全 monorepo 綠（apps/api 79 個含新 6 個：recurring-invest 3＋m6 3）；`pnpm typecheck` 11 專案全過；`pnpm lint` 0 errors（2 個既有無關 warning）；`pnpm --filter ./apps/web build` 成功（precache 10 entries）。
- 沒驗證的：真實 AI 端點連線（測試用 mock 的 OpenAI 相容回應——作者拿真的 Workers AI／Ollama 端點在設定頁「測試連線」即可驗）、Docker build（開發機無 Docker）、真實 Discord 指令註冊。

## 待作者實測

1. dev:lite 開起來：帳戶頁補兩個帳戶的銀行 → 記一筆 chips 顯示銀行。
2. 週期頁建一條定期定額（要先有投資帳戶＋標的）→ 首頁 30 天預計支出多了圈存 → 確認填實際金額股數。
3. 設定頁 AI 區塊接一個真端點測連線 → 對帳頁試「AI 幫我整理」。
4. M5/M6 退出條件仍待真實使用驗收（一個月不開 PWA 不漏繳款；審計確認時間下降）。

（前輪紀錄如下）

## 本輪新增：帳戶 institution 欄位（migration 0008）

作者連續反饋「到處都看不出是哪家銀行」——根因是資料模型裡一般帳戶沒有機構概念（只有信用卡在 credit_cards.issuer）。落地：
- **Schema**：`accounts.institution`（nullable text，migration `0008_purple_lady_vermin`——單一 ADD COLUMN，additive 安全）；DATA_MODEL §3.1 已同步。
- **Zod／mutation**：`zAccountCreate/Update`、`zInvestmentAccountCreate` 皆支援；`createInvestmentAccount` 會把券商寫進配對建立的交割＋投資資產帳戶。
- **UI**：共用 `institution.tsx`（`TAIWAN_BANKS` 23 家、`TAIWAN_BROKERS` 16 家、`InstitutionSelect` 下拉＋其他自填；獨立模組避免 accounts↔investments 循環依賴）。建立／編輯銀行存款・數位帳戶・投資交割用銀行清單，投資帳戶用券商清單；選機構帶入名稱且**同機構已有帳戶時自動加序號**（彼岸花銀行 2）防撞名。帳戶清單副標、記一筆 chips、淨資產泡泡（信用卡取 issuer）都顯示機構，名稱已含機構就不重複。
- **測試**：api.test 新增 2 個（建立/更新 institution、投資帳戶寫穿交割與資產帳戶），全套 73 過。
- **淨資產泡泡同步改版**：軌道從橢圓改**正圓 R120**（作者嫌橢圓）、stage 加高到 21.5rem（作者說空間可以大）、球 64–88px 內含三行（機構／名稱／金額）、槽位改黃金角公式（-54°+i·137.5°）。已知天花板：360px 窄機軌道左右貼齊容器邊、5-6 顆大球相鄰可能輕微相疊。
- **實體鍵盤**（快速記帳金額）：數字／小數點直接輸入、Backspace/Delete 刪除、**Ctrl+A 全選**（金額框高亮，再輸入＝取代、Backspace＝清空、Esc 取消）、Enter 儲存；焦點在任何輸入框或對話框開啟時不攔截。
- `docs/OPEN_QUESTIONS.md` 新增 **Q18 定期定額**（作者提議「可以考慮」→ 選項＋推薦 (a) recurring_rules 擴充 invest_buy kind，需人工決策，未實作）。

（前輪紀錄如下）
- 上一版標題：2026-07-18（UI 輪三修：珠鏈佈局＋完整備份匯入）
- 本輪目標：作者實測截圖反饋「可讀性趨近於 0」（球沉進核底、顏色太淡）→ 珠鏈佈局修正；作者指出「只有匯出沒有匯入」→ 完整 JSON 備份還原功能
- 重要邊界：`/api/net-worth` 新增 `sources` 欄位、新增 `POST /api/import/json`；無 schema／migration 變動

## 本輪新增：完整備份匯入（POST /api/import/json）

- `packages/database/src/restore.ts`：`restoreAllData`——只允許還原到**未動過的帳本**（無交易、無 journal、無帳單，否則 409 `LEDGER_NOT_EMPTY`）；還原前把註冊自動建立的預設分類／期初帳戶清掉（此時無 journal 參照，安全），以備份內容原樣取代，避免兩套預設分類。25 張表依外鍵順序單一交易插入；入庫前逐 journal entry 分幣別驗證平衡（不平衡整包拒收 422）；匯率是共用表用 `onConflictDoNothing`；匯入行為本身寫一筆 audit log。欄位轉換用 `getTableColumns` 依 dataType 通用轉回（ISO 字串→Date、字串→BigInt）。
- **刻意跳過的表**（原因寫在 restore.ts 註解）：`change_log`（bigserial 同步游標是伺服器本地的）、`sync_devices`、`jobs`、`discord_links`、`web_push_subscriptions`（裝置／環境綁定，新環境重新建立）。
- **已知限制**：帳單原始檔的加密 blob 存在 file-store（磁碟／R2），不在 JSON 匯出內，還原後 `import_files` 只剩 metadata、原始檔內容不可再下載（解析結果與 statement_items 都在）。
- 這是 domain service 之外唯一的帳本寫入路徑——寫的是當初已過 domain 驗證的匯出資料＋重驗平衡，屬刻意的 reviewed 例外（restore.ts 檔頭有註記）。
- Web：設定頁「資料所有權」新增「匯入完整備份（JSON）」檔案選擇，成功後 toast＋reload；README 現況同步。
- 測試：`apps/api/test/import.test.ts` 4 個——雙 PGlite 伺服器 round-trip（舊機記帳→匯出→新機匯入→淨資產一致、帳戶總數一致、再匯出筆數一致）、重複匯入 409、非備份檔 422。

## 設計拍板紀錄（改 UI 前先讀）

- 方向：「中心引力」（A 比例條／B 迷你資產負債表／C 中心引力三案中作者選 C），理由是低認知負荷。
- v2（作者反饋）：不包卡片（違反 ui-complexity），區隔用光暈＋點點軌道；泡泡從三大類展開成**逐帳戶來源**；動畫提速。抄襲是紅線（不能像永豐大戶）。
- v3（作者實測截圖反饋「可讀性趨近於 0」）：v2 的橢圓壓縮讓球沉進核底下、球色太淡。改成**珠鏈佈局**——球心直接落在畫出來的軌道橢圓上（`ORBIT_RX=122, RY=92`，同一條），數學上保證不與核重疊；核縮到 120px、球 56–72px；球底色加深（tint 24–36% 混 surface）、名稱用正文色。可讀性 > 有機感。
- 通用原則：分層用底色對比＋間距不濫用線條；文案不用工程師用語（「實例」已全站移除）。

## 本輪新增：帳戶管理補全（作者反饋「只能新增不能刪、編輯入口找不到」）

- **刪除**：後端 `deleteAccount` 從 M1 起就存在（軟刪除；有 journal 參照回 `ACCOUNT_IN_USE` 引導封存；投資配對帳戶引導從投資區管理），純粹是 UI 沒入口。帳戶明細頁底部補「刪除這個帳戶／這張卡」danger 按鈕＋確認對話框；新增 2 個 API 測試（無紀錄可刪、有紀錄拒絕）。
- **編輯卡片**：後端 update 早支援 `creditCard` partial merge，補「編輯卡片」對話框（發卡行／末四碼／額度／結帳日／繳款截止日）。
- **發卡行下拉**：台灣常見銀行清單（UI 層常數 `TAIWAN_BANKS`）＋「其他」自填，取代純手打。
- **名稱去重**：砍掉「卡片名稱」欄位，`cardName` 一律＝帳戶名稱（新增與編輯皆同），使用者只填一次名字。
- **可發現性**：帳戶列表每列加 ChevronRight，暗示可點入明細（改名／封存／刪除／編輯都在裡面）。
- **結帳日／繳款日自動帶入**：新增卡片時，選共用額度群組（優先）或同發卡行既有卡 → 自動帶入該卡的結帳日／繳款日、發卡行空白時一併帶入；使用者手動改過就不再覆寫（`daysTouched`），欄位永遠可編輯（凡事有例外）。
- **範例去品牌化**（作者拍板的界線）：**銀行**範例不得用真實名稱——「例：國泰 CUBE」→「例：彼岸花銀行 紅蓮卡」、「例：國泰證券」→「例：彼岸花證券」；**大眾認知標的**（0050／元大台灣50、Netflix）作者明示沒關係，維持原樣。發卡行下拉的真實銀行清單是功能性選項（作者點名要的），保留。
- **銀行存款也有銀行選單**：新增與編輯（明細頁「編輯」對話框）銀行存款／數位帳戶時都有 `IssuerSelect` 下拉，選銀行帶入名稱、可再改（帳戶 schema 沒有銀行欄位，名稱即識別，刻意不加欄位）。
- **記一筆 chips 顯示銀行**：信用卡 chip 顯示「發卡行＋卡名」（名稱已含發卡行不重複）。
- **溢出修正**：核內淨資產數字依字元數自動縮字級（96px 寬度預算、tabular 0.62em/字估算）；泡泡金額 ≥5 位數改「萬／億」緊湊格式（BigInt 運算、遮蔽優先、精確值在帳戶頁）。
- **末四碼**：儲存本來就只有末四碼（`zCreditCardFields` 有 regex 限制、ACCT-7 規格允許、選填），資安風險低；顯示上補接隱私遮蔽（開眼睛時列表顯示「••••」）。

## 本輪其他變更（同日累積）

- `packages/database/src/queries.ts`：`netWorthSummary` 新增 `sources`（逐帳戶：cash 帳戶各一、負債各一、持倉依 assetAccountId 聚合成逐投資帳戶，皆已換算基準幣別）。
- `packages/domain/src/accounts.ts`：Q17 拍板落地——預設支出分類加「海外交易手續費」、預設收入分類加「信用卡回饋」（現金折抵用）；Q17 移到 OPEN_QUESTIONS 已解決。
- `apps/web/src/pages/quick-add.tsx`：中心引力 v3（珠鏈）＋隱私遮蔽眼睛＋「＋自訂」分類入口。
- `apps/web/src/store.ts`：全域隱私遮蔽（`formatAmount` 單點）＋`NetWorthSourceJson` 型別。
- `settings.tsx`／`login.tsx`：去線條化＋「實例」用語移除＋匯入備份 UI。
- `AGENTS.md`：回應一律使用中文。

## 設計拍板紀錄（改這塊 UI 前先讀）

- 方向：「中心引力」（作者在 A 比例條／B 迷你資產負債表／C 中心引力三案中選 C），理由是低認知負荷——「很累的時候不想一次知道這麼多資訊」。
- v2 修正（作者反饋）：**不包卡片**（違反 ui-complexity），區隔改用融進頁面背景的光暈＋點點軌道；泡泡從「現金／投資／負債三顆」展開成**逐帳戶來源**（每個銀行帳戶、每個投資帳戶、每筆負債各一顆），這才是統計不是視覺化；動畫全面縮短提速。**抄襲是紅線**——不能長得像永豐大戶或任何參考 App。
- 通用原則：分層用底色對比＋間距，不濫用線條／卡片／圓角；文案不用工程師用語（「實例」已全數移除）。

## 本輪變更

### `packages/database/src/queries.ts`（API 資料）

- `netWorthSummary` 新增 `sources: NetWorthSource[]`：逐帳戶展開——非投資資產帳戶各一筆（`kind:'cash'`）、負債帳戶各一筆（`kind:'liability'`，正數＝欠款）、持倉依 `assetAccountId` 聚合成逐投資帳戶（`kind:'investment'`，市值）。金額皆已換算基準幣別、零金額不列。既有欄位不動。

### `packages/domain/src/accounts.ts`（Q17 拍板落地）

- 預設支出分類新增「海外交易手續費」；預設收入分類新增「信用卡回饋」（現金折抵用，點數不做）。既有使用者會在帳戶頁看到「補上分類」提示自行加入。

### `apps/web/src/pages/quick-add.tsx`（中心引力 v2）

- **無卡片**：構圖直接坐在頁面背景上，聚焦靠核後方 320px 半徑的 accent-soft 放射光暈（融進背景）＋一圈點點軌道橢圓（SVG `stroke-dasharray="0.1 11"` 圓點，可愛版的分隔線）。
- **泡泡＝資產來源**：`data.sources` 依金額排序取前 5 顆，其餘合併成「其他 N 項」灰泡；大小 52–80px（開根號比例、有下限保可讀）；槽位用黃金角序列（-50° 起每顆 +137.5°）配橢圓軌道（y×0.74）與交錯距離，數量不定也不會排成僵硬圓環——與參考 App 的版式做出區隔。泡泡顯示帳戶名＋金額，色彩依類型（現金 accent／投資 chart-2／負債 negative）再按序號微調濃度，左上角有泡泡光澤高光。
- **動畫提速**（回應「lag lag 的」）：核 0.35s、泡泡 0.38s stagger 0.06 無前置延遲、數字跳動 0.9s；漂浮振幅 4–6px、方向與週期交錯；核與泡泡加 `will-change: transform`。reduced-motion 全跳過、靜態即終態。
- 隱私遮蔽眼睛、置中 meta 行（30 天預計支出／新鮮度／不完整警示）保留。

### 文案（`settings.tsx`、`login.tsx`）

- 「實例」全數移除：「此實例的邀請碼」→「邀請其他使用者」、「這個實例尚未設定 Discord 整合」→「這裡還沒開通 Discord 整合」、「這個實例尚未設定 Web Push」→「這裡還沒開通推播通知」、「自架實例的備援」→「自己架設時的備援」、「第一個帳號會成為這個實例的管理者」→「第一個帳號會成為管理者」。

### 文件

- `docs/OPEN_QUESTIONS.md`：Q17 移到已解決（回饋只做現金折抵→「信用卡回饋」收入分類；海外手續費→獨立支出分類；作者 2026-07-18 拍板）。

### 上一小輪（同日稍早）已完成並保留

- 全站隱私遮蔽（`formatAmount` 單點遮蔽＋`odk-privacy-mask` 事件重渲染）、記一筆「＋自訂」分類入口、設定頁去線條化、AGENTS.md「回應一律使用中文」。

## 本輪實際驗證

- `pnpm typecheck`：11 個 workspace 專案全過。
- `pnpm test`：全綠（apps/api 65、notifications 16、importers 9、其餘 package 皆通過，指令 exit 0）——含動過的 `netWorthSummary` 與預設分類相關測試。
- `pnpm lint`：0 errors（2 個 `worker-configuration.d.ts` 既有無關 warning）。
- `pnpm --filter ./apps/web build`：成功，PWA precache 10 entries。

## 未驗證／已知風險

- **仍未在真實瀏覽器實看**：泡泡佈局在 5+其他顆時的重疊程度、深色模式的光澤高光強度、動畫實際順暢度（「lag」的根因只能靠實測確認——本輪用縮短時程＋will-change＋去掉大面積卡片重繪來壓，若還卡，下一步查 devtools performance）。作者可 `pnpm --filter @okane-dokoitta/api dev:lite` ＋ `pnpm --filter @okane-dokoitta/web dev` 實看。
- 泡泡名稱過長會截斷（truncate）、金額位數極多會貼邊：已知天花板。
- 帳戶頁清單、記一筆「待確認扣款」仍是舊線條風格；全站統一要作者點頭。
- M5 遺留未驗證項（真實 Discord／Web Push／PWA SW 瀏覽器行為）不變，見 Q10/Q15/Q16。

## 下一個可執行步驟

1. 作者實看 v2（亮／暗、遮蔽、reduced-motion、多帳戶時的泡泡佈局），回報動畫是否還卡、槽位是否需微調。
2. M3 對帳細化時把「回饋入帳行」「手續費行」納入自動配對（Q17 已解決的後續）。
3. M5 遺留：真實 Discord／Web Push／PWA 離線導覽驗證。
