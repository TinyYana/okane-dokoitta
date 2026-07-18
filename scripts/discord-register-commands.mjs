/**
 * 把 /finance slash 指令註冊到 Discord（一次性，指令定義變更時再跑）。
 * 用法：設好環境變數後 `node scripts/discord-register-commands.mjs`
 *   OKANE_DOKOITTA_DISCORD_APP_ID、OKANE_DOKOITTA_DISCORD_BOT_TOKEN
 * 子指令清單要跟 apps/api/src/discord-routes.ts 的 handleFinanceCommand 一致。
 */
const appId = process.env.OKANE_DOKOITTA_DISCORD_APP_ID;
const botToken = process.env.OKANE_DOKOITTA_DISCORD_BOT_TOKEN;
if (!appId || !botToken) {
  console.error('請先設定 OKANE_DOKOITTA_DISCORD_APP_ID 與 OKANE_DOKOITTA_DISCORD_BOT_TOKEN');
  process.exit(1);
}

const SUB = (name, description, options = []) => ({ type: 1, name, description, options });
const commands = [
  {
    name: 'finance',
    description: '記帳查詢與提醒（財務資訊只出現在私訊或僅自己可見的回覆）',
    options: [
      SUB('status', '總覽摘要'),
      SUB('networth', '淨資產與資料時間'),
      SUB('upcoming', '未來 14 天預計扣款與繳款'),
      SUB('cards', '各卡結帳／繳款日與本期金額'),
      SUB('pending', '未確認交易與預計交易'),
      SUB('audit-status', '最近對帳狀態與差額'),
      SUB('reminders', '提醒設定總覽'),
      SUB('add', '快速記一筆草稿（回 PWA 確認才入帳）', [
        { type: 3, name: 'amount', description: '金額，例：120', required: true },
        { type: 3, name: 'note', description: '備註／商家，例：午餐', required: false },
      ]),
      SUB('confirm', '列出待確認的預計扣款，逐筆按鈕確認'),
      SUB('link', '把這個 Discord 帳號連結到記帳帳號'),
    ],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});
if (!res.ok) {
  console.error(`註冊失敗：HTTP ${res.status}`, await res.text());
  process.exit(1);
}
console.log('✓ /finance 指令已註冊（全域指令最多等約 1 小時生效；重跑無害）');
