import { parseAmount } from '@okane-dokoitta/domain';
import { Button, Dialog, Field, Select, TextInput, useToast } from '@okane-dokoitta/ui';
import { useEffect, useState } from 'react';
import { api, ApiError, mutate, newEntityId } from '../api.js';
import { InstitutionSelect, TAIWAN_BROKERS } from '../institution.jsx';
import {
  formatAmount,
  isActive,
  useAccounts,
  type AccountJson,
  type HoldingJson,
  type InvestmentAccountJson,
  type SecurityJson,
} from '../store.js';

interface InvestmentsData {
  investmentAccounts: InvestmentAccountJson[];
  securities: SecurityJson[];
  holdings: HoldingJson[];
}

export function useInvestments() {
  const [data, setData] = useState<InvestmentsData>({ investmentAccounts: [], securities: [], holdings: [] });
  const [loaded, setLoaded] = useState(false);
  async function reload() {
    const result = await api.get<InvestmentsData>('/api/investments');
    setData(result);
    setLoaded(true);
  }
  useEffect(() => {
    void reload();
  }, []);
  return { ...data, loaded, reload };
}

function accountTotalMinor(inv: InvestmentAccountJson, accounts: AccountJson[], holdings: HoldingJson[]): bigint {
  const settlement = accounts.find((a) => a.id === inv.settlementAccountId);
  const settlementMinor = settlement ? BigInt(settlement.balanceMinor) : 0n;
  const holdingsMinor = holdings
    .filter((h) => h.assetAccountId === inv.assetAccountId)
    .reduce((sum, h) => sum + BigInt(h.marketValueMinor ?? h.costBasisMinor), 0n);
  return settlementMinor + holdingsMinor;
}

function investmentAccountType(inv: InvestmentAccountJson, accounts: AccountJson[]): '台股' | '複委託' | '外幣投資' {
  if (inv.currency === 'TWD') return '台股';
  const institution = accounts.find((account) => account.id === inv.assetAccountId)?.institution;
  return TAIWAN_BROKERS.includes(institution ?? '') ? '複委託' : '外幣投資';
}

function investmentDisplayName(inv: InvestmentAccountJson, accounts: AccountJson[]): string {
  if (inv.name.includes(inv.currency) || inv.name.includes('複委託')) return inv.name;
  const type = investmentAccountType(inv, accounts);
  return type === '台股' ? `${inv.name}（台股）` : `${inv.name}（${inv.currency} ${type}）`;
}

function suggestedInvestmentName(broker: string, currency: string): string {
  if (!broker) return '';
  return currency === 'TWD' ? `${broker} 台股` : `${broker} ${currency} 複委託`;
}

/** 帳戶頁的「投資」清單區塊（與資產/信用卡並列）。 */
export function InvestmentSection({
  investmentAccounts,
  holdings,
  loaded,
  onAddNew,
}: {
  investmentAccounts: InvestmentAccountJson[];
  holdings: HoldingJson[];
  loaded: boolean;
  onAddNew: () => void;
}) {
  const { accounts } = useAccounts();
  return (
    <section>
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-[var(--odk-muted)]">
        <span>投資</span>
        <button type="button" onClick={onAddNew} className="text-[var(--odk-accent)]">
          ＋ 新增投資帳戶
        </button>
      </div>
      {!loaded || investmentAccounts.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--odk-line)] p-3 text-center text-sm text-[var(--odk-muted)]">
          還沒有投資帳戶
        </p>
      ) : (
        <ul className="odk-data-list overflow-hidden rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)]">
          {investmentAccounts.map((inv) => (
            <li key={inv.id}>
              <a href={`#/accounts/investment/${inv.id}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--odk-surface-2)]">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{investmentDisplayName(inv, accounts)}</div>
                  <div className="text-xs text-[var(--odk-muted)]">{investmentAccountType(inv, accounts)} · {inv.currency}</div>
                </div>
                <span className="odk-amount text-sm">{formatAmount(accountTotalMinor(inv, accounts, holdings).toString(), inv.currency)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function NewInvestmentAccountDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [broker, setBroker] = useState('');
  const [currency, setCurrency] = useState('TWD');
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);

  function pickBroker(next: string) {
    if (!nameEdited) setName(suggestedInvestmentName(next, currency));
    setBroker(next);
  }


  function pickCurrency(next: string) {
    setCurrency(next);
    if (!nameEdited) setName(suggestedInvestmentName(broker, next));
  }

  async function save() {
    if (!name.trim()) return toast('輸入券商名稱', 'error');
    setBusy(true);
    try {
      await mutate('investment_accounts', 'create', newEntityId(), {
        name: name.trim(),
        institution: broker || null,
        currency,
      });
      toast('投資帳戶已建立 ✓');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '建立失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="新增投資帳戶">
      <div className="space-y-3">
        <InstitutionSelect label="券商" options={TAIWAN_BROKERS} value={broker} onChange={pickBroker} />
        <Field label="帳戶名稱" hint="台股與外幣複委託會自動標出；建立時也會配對交割現金與投資資產帳戶">
          <TextInput value={name} onChange={(e) => { setName(e.target.value); setNameEdited(true); }} placeholder="例：彼岸花證券 台股" />
        </Field>
        <Field label="幣別">
          <Select value={currency} onChange={(e) => pickCurrency(e.target.value)}>
            <option value="TWD">TWD</option>
            <option value="USD">USD</option>
            <option value="JPY">JPY</option>
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            建立
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function InvestmentAccountDetail({ investmentAccountId }: { investmentAccountId: string }) {
  const { accounts } = useAccounts();
  const toast = useToast();
  const { investmentAccounts, securities, holdings, loaded, reload } = useInvestments();
  const [dialog, setDialog] = useState<'opening' | 'buy' | 'sell' | 'dividend' | null>(null);
  const [editingSecurity, setEditingSecurity] = useState<SecurityJson | null>(null);
  const [refreshingQuote, setRefreshingQuote] = useState<string | null>(null);

  const inv = investmentAccounts.find((i) => i.id === investmentAccountId);
  if (!loaded) return <p className="text-[var(--odk-muted)]">載入中…</p>;
  if (!inv) return <p className="text-[var(--odk-muted)]">找不到投資帳戶</p>;

  const settlement = accounts.find((a) => a.id === inv.settlementAccountId);
  const settlementMinor = settlement ? BigInt(settlement.balanceMinor) : 0n;
  const ownHoldings = holdings.filter((h) => h.assetAccountId === inv.assetAccountId);
  const holdingsMinor = ownHoldings.reduce((sum, h) => sum + BigInt(h.marketValueMinor ?? h.costBasisMinor), 0n);
  const totalMinor = settlementMinor + holdingsMinor;

  async function refreshQuote(holding: HoldingJson) {
    setRefreshingQuote(holding.securityId);
    try {
      const result = await api.post<{ price: string; provider: string }>('/api/investments/prices/refresh', {
        securityId: holding.securityId,
      });
      toast(`${holding.symbol} 已由 ${result.provider.toUpperCase()} 更新為 ${result.price} ${holding.currency} ✓`);
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '自動報價更新失敗', 'error');
    } finally {
      setRefreshingQuote(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href="#/accounts" className="text-[var(--odk-muted)]">←</a>
        <h1 className="odk-page-title min-w-0 flex-1 truncate text-xl font-semibold">{investmentDisplayName(inv, accounts)}</h1>
        <span className="rounded-full bg-[var(--odk-surface-2)] px-2 py-1 text-xs text-[var(--odk-muted)]">{investmentAccountType(inv, accounts)} · {inv.currency}</span>
      </div>

      <div className="odk-panel rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)] p-5 text-center">
        <div className="text-xs text-[var(--odk-muted)]">投資帳戶總值（交割現金＋持倉市值）</div>
        <div className="odk-amount mt-1 text-3xl font-semibold">{formatAmount(totalMinor.toString(), inv.currency)}</div>
        <div className="mt-1 text-xs text-[var(--odk-muted)]">交割現金 {formatAmount(settlementMinor.toString(), inv.currency)}</div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Button variant="primary" className="justify-center py-2.5" onClick={() => setDialog('opening')}>登記現有持倉</Button>
        <Button variant="primary" className="justify-center py-2.5" onClick={() => setDialog('buy')}>買入</Button>
        <Button className="justify-center py-2.5" onClick={() => setDialog('sell')} disabled={ownHoldings.length === 0}>賣出</Button>
        <Button className="justify-center py-2.5" onClick={() => setDialog('dividend')}>股息</Button>
      </div>

      <section className="odk-panel overflow-hidden rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)]">
        <h2 className="border-b border-[var(--odk-line)] px-3 py-2 text-sm font-medium">持倉</h2>
        {ownHoldings.length === 0 ? (
          <p className="p-4 text-center text-sm text-[var(--odk-muted)]">還沒有持倉</p>
        ) : (
          <ul className="divide-y divide-[var(--odk-line)]">
            {ownHoldings.map((h) => (
              <li key={h.id} className="space-y-1 px-3 py-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {h.symbol}<span className="ml-1 text-xs text-[var(--odk-muted)]">{h.name}</span>
                    </div>
                    <div className="text-xs text-[var(--odk-muted)]">{h.market} · {h.currency} · {h.quantity} 股 · 成本 {formatAmount(h.costBasisMinor, h.currency)}</div>
                    <button
                      type="button"
                      className="text-xs text-[var(--odk-accent)]"
                      onClick={() => setEditingSecurity(securities.find((security) => security.id === h.securityId) ?? null)}
                    >
                      編輯標的
                    </button>
                  </div>
                  <div className="text-right">
                    <div className="odk-amount">{h.marketValueMinor ? formatAmount(h.marketValueMinor, h.currency) : '尚無報價'}</div>
                    {h.marketValueMinor ? <UnrealizedPnl marketValueMinor={h.marketValueMinor} costBasisMinor={h.costBasisMinor} currency={h.currency} /> : null}
                    <button
                      type="button"
                      className="text-xs text-[var(--odk-accent)] disabled:opacity-50"
                      disabled={refreshingQuote === h.securityId}
                      onClick={() => void refreshQuote(h)}
                    >
                      {refreshingQuote === h.securityId
                        ? '更新中…'
                        : h.latestPrice
                          ? `自動更新報價（${relativeDays(h.latestPrice.asOf)}）`
                          : '取得自動報價'}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog === 'opening' || dialog === 'buy' || dialog === 'sell' ? (
        <BuySellDialog
          kind={dialog === 'opening' ? 'adjustment' : dialog === 'buy' ? 'invest_buy' : 'invest_sell'}
          investmentAccount={inv}
          securities={securities}
          holdings={ownHoldings}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); void reload(); }}
        />
      ) : null}
      {dialog === 'dividend' ? (
        <DividendDialog investmentAccount={inv} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void reload(); }} />
      ) : null}
      {editingSecurity ? (
        <SecurityEditDialog
          security={editingSecurity}
          onClose={() => setEditingSecurity(null)}
          onSaved={() => { setEditingSecurity(null); void reload(); }}
        />
      ) : null}
    </div>
  );
}

function BuySellDialog({
  kind,
  investmentAccount,
  securities,
  holdings,
  onClose,
  onSaved,
}: {
  kind: 'adjustment' | 'invest_buy' | 'invest_sell';
  investmentAccount: InvestmentAccountJson;
  securities: SecurityJson[];
  holdings: HoldingJson[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { accounts } = useAccounts();
  const toast = useToast();
  const isSell = kind === 'invest_sell';
  const isOpening = kind === 'adjustment';
  const candidates = isSell
    ? securities.filter((s) => holdings.some((h) => h.securityId === s.id))
    : securities.filter((s) => s.currency === investmentAccount.currency);
  const [securityId, setSecurityId] = useState(candidates[0]?.id ?? '__new__');
  const [newSymbol, setNewSymbol] = useState('');
  const [newName, setNewName] = useState('');
  const [newMarket, setNewMarket] = useState('TW');
  const [newCurrency, setNewCurrency] = useState(investmentAccount.currency);
  const [newKind, setNewKind] = useState<'stock' | 'etf'>('stock');
  const [quantity, setQuantity] = useState('');
  const [amount, setAmount] = useState('');
  const incomeCategories = accounts.filter((a) => a.subtype === 'category_income' && isActive(a));
  const [categoryId, setCategoryId] = useState(incomeCategories[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const heldQuantity = isSell ? holdings.find((h) => h.securityId === securityId)?.quantity : undefined;

  async function save() {
    let secId = securityId;
    if (!isSell && securityId === '__new__') {
      if (!newSymbol.trim() || !newName.trim()) return toast('輸入標的代號與名稱', 'error');
      if (newCurrency !== investmentAccount.currency) {
        return toast(`這是 ${investmentAccount.currency} 投資帳戶；${newCurrency} 標的請先建立 ${newCurrency} 投資帳戶`, 'error');
      }
      secId = newEntityId();
      try {
        await mutate('securities', 'create', secId, {
          symbol: newSymbol.trim(),
          name: newName.trim(),
          market: newMarket.trim() || '—',
          currency: newCurrency,
          kind: newKind,
        });
      } catch (err) {
        return toast(err instanceof ApiError ? err.message : '標的建立失敗', 'error');
      }
    }
    if (!secId || secId === '__new__' || !quantity || !amount) return toast('選標的、輸入股數與金額', 'error');
    if (isSell && !categoryId) return toast('選擇損益分類', 'error');
    setBusy(true);
    try {
      await mutate('transactions', 'create', newEntityId(), {
        type: kind,
        amountMinor: parseAmount(amount, investmentAccount.currency).toString(),
        currency: investmentAccount.currency,
        investmentAccountId: investmentAccount.id,
        securityId: secId,
        quantity,
        categoryAccountId: isSell ? categoryId : null,
        note: note || null,
        occurredAt: new Date().toISOString(),
        source: 'manual',
      });
      toast(isSell ? '賣出已記錄 ✓' : isOpening ? '現有持倉已登記，未扣交割現金 ✓' : '買入已記錄 ✓');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '記錄失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={isSell ? `賣出 — ${investmentAccount.name}` : isOpening ? `登記現有持倉 — ${investmentAccount.name}` : `買入 — ${investmentAccount.name}`}>
      <div className="space-y-3">
        {isOpening ? (
          <p className="rounded-md bg-[var(--odk-accent-soft)] p-3 text-sm text-[var(--odk-text)]">
            用來建立開始記帳前就已持有的部位；成本由期初權益平衡，不會扣掉交割現金。
          </p>
        ) : null}
        <Field label="標的">
          <Select value={securityId} onChange={(e) => setSecurityId(e.target.value)}>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>{s.symbol}（{s.name}）</option>
            ))}
            {!isSell ? <option value="__new__">＋ 新增標的</option> : null}
          </Select>
        </Field>
        {!isSell && securityId === '__new__' ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="代號"><TextInput value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} placeholder="0050" /></Field>
            <Field label="名稱"><TextInput value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="元大台灣50" /></Field>
            <Field label="市場"><TextInput value={newMarket} onChange={(e) => setNewMarket(e.target.value)} placeholder="TW" /></Field>
            <Field label="報價幣別">
              <Select value={newCurrency} onChange={(e) => setNewCurrency(e.target.value)}>
                <option value="TWD">TWD（新臺幣）</option>
                <option value="USD">USD（美元）</option>
                <option value="JPY">JPY（日圓）</option>
              </Select>
            </Field>
            <Field label="類型">
              <Select value={newKind} onChange={(e) => setNewKind(e.target.value as 'stock' | 'etf')}>
                <option value="stock">個股</option>
                <option value="etf">ETF</option>
              </Select>
            </Field>
          </div>
        ) : null}
        <Field label="股數" hint={heldQuantity ? `目前持有 ${heldQuantity} 股` : undefined}>
          <TextInput inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="100" />
        </Field>
        <Field label={`${isSell ? '賣出總額' : isOpening ? '目前持倉總成本' : '買入總額'}（${investmentAccount.currency}${isOpening ? '' : '，已含手續費'}）`}>
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {isSell ? (
          <Field label="損益分類" hint="有賺賠時差額會計入這個分類">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {incomeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label="備註（選填）"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>{isSell ? '記賣出' : isOpening ? '登記期初持倉' : '記買入'}</Button>
        </div>
      </div>
    </Dialog>
  );
}

function DividendDialog({
  investmentAccount,
  onClose,
  onSaved,
}: {
  investmentAccount: InvestmentAccountJson;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { accounts } = useAccounts();
  const toast = useToast();
  const incomeCategories = accounts.filter((a) => a.subtype === 'category_income' && isActive(a));
  const dividendDefault = incomeCategories.find((c) => c.name.includes('股息')) ?? incomeCategories[0];
  const [categoryId, setCategoryId] = useState(dividendDefault?.id ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!categoryId || !amount) return toast('選分類、輸入金額', 'error');
    setBusy(true);
    try {
      await mutate('transactions', 'create', newEntityId(), {
        type: 'dividend',
        amountMinor: parseAmount(amount, investmentAccount.currency).toString(),
        currency: investmentAccount.currency,
        investmentAccountId: investmentAccount.id,
        categoryAccountId: categoryId,
        merchantRaw: note || null,
        occurredAt: new Date().toISOString(),
        source: 'manual',
      });
      toast('股息已記錄 ✓');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '記錄失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`股息 — ${investmentAccount.name}`}>
      <div className="space-y-3">
        <Field label={`金額（${investmentAccount.currency}，稅後淨額）`}>
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="分類">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {incomeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="備註（選填）"><TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="標的名稱" /></Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>記股息</Button>
        </div>
      </div>
    </Dialog>
  );
}

function SecurityEditDialog({ security, onClose, onSaved }: { security: SecurityJson; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [symbol, setSymbol] = useState(security.symbol);
  const [name, setName] = useState(security.name);
  const [market, setMarket] = useState(security.market);
  const [currency, setCurrency] = useState(security.currency);
  const [kind, setKind] = useState<'stock' | 'etf'>(security.kind);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!symbol.trim() || !name.trim() || !market.trim()) return toast('代號、名稱與市場不能空白', 'error');
    setBusy(true);
    try {
      await mutate('securities', 'update', security.id, {
        symbol: symbol.trim(),
        name: name.trim(),
        market: market.trim().toUpperCase(),
        currency,
        kind,
      }, security.version);
      toast('標的資料已更新 ✓');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '更新失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`編輯標的 — ${security.symbol}`}>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="代號"><TextInput value={symbol} onChange={(e) => setSymbol(e.target.value)} /></Field>
          <Field label="名稱"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="市場" hint="台股用 TW；美股／美國 ETF 用 US">
            <TextInput value={market} onChange={(e) => setMarket(e.target.value)} placeholder="US" />
          </Field>
          <Field label="報價幣別" hint="已有持倉時，幣別必須與投資帳戶一致">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="TWD">TWD（新臺幣）</option>
              <option value="USD">USD（美元）</option>
              <option value="JPY">JPY（日圓）</option>
            </Select>
          </Field>
          <Field label="類型">
            <Select value={kind} onChange={(e) => setKind(e.target.value as 'stock' | 'etf')}>
              <option value="stock">個股</option>
              <option value="etf">ETF</option>
            </Select>
          </Field>
        </div>
        {currency !== security.currency ? (
          <p className="rounded-md bg-[var(--odk-accent-soft)] p-3 text-sm">
            改幣別會影響所有歷史估值；若已有不同幣別的持倉或報價，系統會拒絕並提示你建立正確幣別的投資帳戶。
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>儲存</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** 未實現損益（INV-2）：市值－成本，推導值，不入帳本。 */
function UnrealizedPnl({ marketValueMinor, costBasisMinor, currency }: { marketValueMinor: string; costBasisMinor: string; currency: string }) {
  const pnl = BigInt(marketValueMinor) - BigInt(costBasisMinor);
  if (pnl === 0n) return null;
  const color = pnl > 0n ? 'text-[var(--odk-positive)]' : 'text-[var(--odk-negative)]';
  return <div className={`text-xs ${color}`}>{pnl > 0n ? '+' : ''}{formatAmount(pnl.toString(), currency)}</div>;
}

function relativeDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return '今天';
  return `${days} 天前`;
}
