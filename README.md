<p align="center">
  <img src="docs/assets/logo.png" alt="okane-dokoitta" width="160" />
</p>
<p align="center">
  <img src="docs/assets/wordmark.png" alt="お金どこいった？" width="360" />
</p>

<p align="center">
  <b>See where your money went.</b><br />
  錢花去哪，打開就知道。
</p>

<p align="center">
  <a href="https://github.com/TinyYana/okane-dokoitta/actions/workflows/ci.yml"><img src="https://github.com/TinyYana/okane-dokoitta/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
</p>

---

記帳 app 很多，但幾乎都停在「記」。真正麻煩的是「對」——信用卡帳單來了，要逐筆核對是不是每一筆都記對、記到了、沒有重複也沒有漏掉；銀行、信用卡、券商散在不同地方，沒有一個畫面看得到全貌。

**okane-dokoitta 把「核對」自動化。** 匯入帳單，系統自動配對你的記帳紀錄，算出差在哪一筆、差多少、可能是什麼原因，每個結論都附證據——不是含糊的 AI 猜測。現金、銀行、信用卡、投資，全部併進同一份看得懂的淨資產。

免費、開源、可以自己架設，資料自己保管。

## 這套工具做什麼

- **記帳**：多個銀行帳戶、多張信用卡（含共用額度），分得清消費日、入帳日、帳單日、實際扣款日
- **自動對帳**：匯入信用卡帳單，自動抓出記錯、漏記、重複、延後入帳，逐筆給理由，一鍵套用或保留不處理
- **資產總覽**：現金、銀行、信用卡、投資（台股／美股／ETF）併成一個看得懂的淨資產，報價自動更新
- **定期定額**：週期規則到期先幫你圈存預估金額，確認時再填實際成交
- **Discord 提醒**：帳單快到期、要繳款、餘額不足會私訊你，也能直接在 Discord 記帳
- **AI 輔助，但你的鑰匙、你的選擇**：想用就接自己的 OpenAI 相容端點（自架模型也行），不想用完全不影響任何核心功能；AI 永遠不會自己動你的帳
- **PWA**：手機、平板、電腦都能裝起來用，離線也能記，多裝置自動同步
- **資料自己帶得走**：完整 JSON 備份匯出／匯入，換自架環境不綁死

## 現況

這是作者自己每天在用的專案，目前程式功能都已經接通，但「真的長期用下來好不好用」這件事還在驗證中——有些角落可能還沒打磨到位。想知道目前實際驗證到哪裡、還有什麼已知限制，看 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## 開始使用

想自己架一套，手把手教學在 [`docs/SETUP_TUTORIAL.md`](docs/SETUP_TUTORIAL.md)（環境變數、Discord bot 申請、AI 接法都有）。最簡單的路線大致是：

```bash
git clone https://github.com/TinyYana/okane-dokoitta.git
cd okane-dokoitta
cp .env.example .env             # 填必要的密鑰，教學裡有產生指令
docker compose build
docker compose up -d db
docker compose run --rm app migrate
docker compose up -d
```

核心功能永久免費，不限制帳戶、卡片、交易或匯出數量。

## 技術與貢獻

TypeScript monorepo（pnpm workspaces）：Hono API＋Cloudflare Workers（也可跑純 Node.js）、React PWA、PostgreSQL＋Drizzle、複式記帳 domain 層。想參與開發或想了解架構決策，從 [`AGENTS.md`](AGENTS.md)（開發守則）與 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 開始，完整文件索引在 `docs/` 目錄下。

## License

[AGPL-3.0](LICENSE)。個人使用與自架完全自由；以本專案提供網路服務時，修改後的原始碼必須同樣開源。
