import { amountToDecimalString, currencyInfo } from '@okane-dokoitta/domain';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

/** 共用資料層：React 內建 state（ARCHITECTURE：暫不引入狀態管理框架）。 */

export interface AccountJson {
  id: string;
  kind: 'asset' | 'liability' | 'income' | 'expense' | 'equity';
  subtype: string;
  name: string;
  institution: string | null;
  currency: string;
  groupId: string | null;
  archivedAt: string | null;
  balanceMinor: string; // 借正貸負的 journal 加總
  version: number;
  creditCard: {
    issuer: string;
    cardName: string;
    last4: string | null;
    creditLimitMinor: string | null;
    limitGroupId: string | null;
    statementDay: number;
    dueDay: number;
    autopayDay: number | null;
    autopayAccountId: string | null;
    status: 'active' | 'frozen' | 'cancelled';
  } | null;
}

export interface LimitGroupJson {
  id: string;
  name: string;
  issuer: string;
  limitMinor: string;
  version: number;
}

export interface TransactionJson {
  id: string;
  type: string;
  status: string;
  amountMinor: string;
  currency: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  categoryAccountId: string | null;
  merchantRaw: string | null;
  note: string | null;
  occurredAt: string;
  version: number;
  needsReview: boolean;
}

export interface RecurringRuleJson {
  id: string;
  name: string;
  freq: 'weekly' | 'monthly' | 'yearly' | 'custom_days';
  interval: number;
  dayOfMonth: number | null;
  month: number | null;
  customEveryDays: number | null;
  amountMinor: string | null;
  currency: string;
  amountToleranceMinor: string;
  dateToleranceDays: number;
  accountId: string;
  categoryAccountId: string | null;
  merchantHint: string | null;
  /** 定期定額（Q18 圈存式）：invest_buy 到期先圈存預估額，確認時填實際成交 */
  kind: 'expense' | 'invest_buy';
  investmentAccountId: string | null;
  securityId: string | null;
  active: boolean;
  nextExpectedDate: string;
  version: number;
}

export interface ExpectedJson {
  id: string;
  ruleId: string | null;
  expectedDate: string;
  amountMinor: string | null;
  currency: string;
  accountId: string;
  status: string;
  version: number;
}

// ---------- 投資（M4）----------

export interface InvestmentAccountJson {
  id: string;
  name: string;
  currency: string;
  settlementAccountId: string;
  assetAccountId: string;
  version: number;
}

export interface SecurityJson {
  id: string;
  symbol: string;
  name: string;
  market: string;
  currency: string;
  kind: 'stock' | 'etf';
  version: number;
}

export interface HoldingJson {
  id: string;
  assetAccountId: string;
  securityId: string;
  symbol: string;
  name: string;
  market: string;
  currency: string;
  quantity: string;
  costBasisMinor: string;
  version: number;
  latestPrice: { price: string; asOf: string } | null;
  marketValueMinor: string | null;
}

export interface NetWorthSourceJson {
  accountId: string;
  name: string;
  institution: string | null;
  kind: 'cash' | 'investment' | 'liability';
  amountMinor: string;
}

export interface NetWorthJson {
  baseCurrency: string;
  cashMinor: string;
  investmentsMinor: string;
  liabilitiesMinor: string;
  netWorthMinor: string;
  sources: NetWorthSourceJson[];
  incomplete: boolean;
  oldestDataAsOf: string | null;
  upcomingOutflow30dMinor: string;
}

export interface AccountsState {
  accounts: AccountJson[];
  limitGroups: LimitGroupJson[];
  loaded: boolean;
  reload: () => Promise<void>;
}

export const AccountsContext = createContext<AccountsState>({
  accounts: [],
  limitGroups: [],
  loaded: false,
  reload: async () => {},
});

export function useAccounts(): AccountsState {
  return useContext(AccountsContext);
}

export function useAccountsProvider(): AccountsState {
  const [accounts, setAccounts] = useState<AccountJson[]>([]);
  const [limitGroups, setLimitGroups] = useState<LimitGroupJson[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    const data = await api.get<{ accounts: AccountJson[]; limitGroups: LimitGroupJson[] }>('/api/accounts');
    setAccounts(data.accounts);
    setLimitGroups(data.limitGroups);
    setLoaded(true);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { accounts, limitGroups, loaded, reload };
}

// ---------- 顯示工具（格式化只在 UI 層；不碰浮點）----------

// 隱私遮蔽（作者核可）：點淨資產卡的眼睛把全站金額顯示成 •••••，狀態記在本機。
// 比例（泡泡大小）不遮——遮的是肩膀後面偷看得到的絕對數字。
let privacyMasked = localStorage.getItem('odk-privacy-mask') === '1';

export function isPrivacyMasked(): boolean {
  return privacyMasked;
}

/** 切換後發全域事件；Shell 監聽並重新渲染，formatAmount 在 render 時讀旗標 */
export function togglePrivacyMask(): void {
  privacyMasked = !privacyMasked;
  localStorage.setItem('odk-privacy-mask', privacyMasked ? '1' : '0');
  window.dispatchEvent(new Event('odk-privacy-mask'));
}

export function formatAmount(minorString: string, currency: string): string {
  if (privacyMasked) return '•••••';
  const info = currencyInfo(currency);
  const decimal = amountToDecimalString(BigInt(minorString), currency);
  const [whole = '', fraction] = decimal.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = decimal.startsWith('-') ? '−' : '';
  return `${sign}${info.symbol}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** 帳戶自然餘額：負債顯示「欠多少」（正數），資產照常 */
export function naturalBalance(account: AccountJson): { text: string; owed: boolean } {
  const raw = BigInt(account.balanceMinor);
  if (account.kind === 'liability') {
    const owed = -raw;
    return { text: formatAmount(owed.toString(), account.currency), owed: owed > 0n };
  }
  return { text: formatAmount(account.balanceMinor, account.currency), owed: false };
}

export const SPENDABLE_SUBTYPES = ['cash', 'bank', 'digital', 'e_wallet', 'brokerage_settlement', 'credit_card'];
export const ASSET_SUBTYPES = ['cash', 'bank', 'digital', 'e_wallet', 'brokerage_settlement', 'investment_asset', 'other_asset'];

export function isActive(account: AccountJson): boolean {
  return account.archivedAt === null;
}

/** 最近使用排序（F1：常用帳戶/分類排前面），localStorage 記錄 */
export function bumpRecent(key: string, id: string): void {
  const list = getRecent(key).filter((x) => x !== id);
  list.unshift(id);
  localStorage.setItem(key, JSON.stringify(list.slice(0, 12)));
}

export function getRecent(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function sortByRecent<T extends { id: string }>(items: T[], recentKey: string): T[] {
  const recent = getRecent(recentKey);
  const rank = new Map(recent.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
}
