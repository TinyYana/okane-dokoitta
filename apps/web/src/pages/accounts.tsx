import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES, amountToDecimalString, parseAmount } from '@okane-dokoitta/domain';
import { Button, Dialog, Field, Select, TextInput, useToast } from '@okane-dokoitta/ui';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, mutate, newEntityId } from '../api.js';
import { categoryIcon } from '../category-icons.js';
import { InstitutionSelect, TAIWAN_BANKS } from '../institution.jsx';
import { formatAmount, isActive, isPrivacyMasked, naturalBalance, useAccounts, type AccountJson } from '../store.js';
import { InvestmentAccountDetail, InvestmentSection, NewInvestmentAccountDialog, useInvestments } from './investments.jsx';

const SUBTYPE_LABEL: Record<string, string> = {
  cash: '現金',
  bank: '銀行存款',
  digital: '數位帳戶',
  e_wallet: '電子支付',
  credit_card: '信用卡',
  brokerage_settlement: '投資交割',
  investment_asset: '投資資產',
  other_asset: '其他資產',
  other_liability: '其他負債',
  category_income: '收入分類',
  category_expense: '支出分類',
  opening_balance: '期初餘額',
};

export function AccountsPage({ route }: { route: string }) {
  const detailId = route.startsWith('/accounts/') ? route.slice('/accounts/'.length) : null;
  if (detailId?.startsWith('investment/')) {
    return <InvestmentAccountDetail investmentAccountId={detailId.slice('investment/'.length)} />;
  }
  if (detailId) return <AccountDetail accountId={detailId} />;
  return <AccountList />;
}

function AccountList() {
  const { accounts, loaded, reload } = useAccounts();
  const { investmentAccounts, holdings, loaded: investmentsLoaded, reload: reloadInvestments } = useInvestments();
  const toast = useToast();
  const [showNew, setShowNew] = useState(false);
  const [showNewInvestment, setShowNewInvestment] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [addingDefaults, setAddingDefaults] = useState(false);

  const active = accounts.filter(isActive);
  const archived = accounts.filter((a) => !isActive(a));
  // 有配對投資帳戶的交割/資產帳戶由「投資」區塊呈現，不重複列在資產清單；
  // 沒配對的（歷史上從新增帳戶對話框直接建的交割戶）仍列出來，不然會隱形
  const pairedIds = new Set(investmentAccounts.flatMap((inv) => [inv.settlementAccountId, inv.assetAccountId]));
  const assets = active.filter(
    (a) => a.kind === 'asset' && (!['brokerage_settlement', 'investment_asset'].includes(a.subtype) || !pairedIds.has(a.id)),
  );
  const cards = active.filter((a) => a.subtype === 'credit_card');
  const liabilities = active.filter((a) => a.subtype === 'other_liability');
  const expenseCategories = active.filter((a) => a.kind === 'expense');
  const incomeCategories = active.filter((a) => a.kind === 'income');
  const missingCategories = [
    ...DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ name, subtype: 'category_expense' as const })),
    ...DEFAULT_INCOME_CATEGORIES.map((name) => ({ name, subtype: 'category_income' as const })),
  ].filter((wanted) => !accounts.some((account) => account.subtype === wanted.subtype && account.name === wanted.name));

  async function addDefaultCategories() {
    setAddingDefaults(true);
    let added = 0;
    try {
      for (const category of missingCategories) {
        await mutate('accounts', 'create', newEntityId(), { ...category, currency: 'TWD' });
        added += 1;
      }
      await reload();
      toast(`已加入 ${added} 個常用分類`);
    } catch (error) {
      await reload();
      toast(error instanceof ApiError ? error.message : `已加入 ${added} 個，後續分類建立失敗`, 'error');
    } finally {
      setAddingDefaults(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="odk-page-title text-xl font-semibold">帳戶</h1>
        <Button variant="primary" onClick={() => setShowNew(true)}>
          ＋ 新增
        </Button>
      </div>
      {!loaded || !investmentsLoaded ? (
        <p className="text-[var(--odk-muted)]">載入中…</p>
      ) : (
        <>
          <Section title="資產" items={assets} />
          <InvestmentSection
            investmentAccounts={investmentAccounts}
            holdings={holdings}
            loaded={investmentsLoaded}
            onAddNew={() => setShowNewInvestment(true)}
          />
          <Section title="信用卡" items={cards} />
          {liabilities.length > 0 ? <Section title="負債" items={liabilities} /> : null}
          <Section title="支出分類" items={expenseCategories} collapsed />
          <Section title="收入分類" items={incomeCategories} collapsed />
          {missingCategories.length ? (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--odk-surface-2)] p-3 text-sm">
              <span>還有 {missingCategories.length} 個常用分類可加入</span>
              <Button disabled={addingDefaults} onClick={() => void addDefaultCategories()}>
                {addingDefaults ? '加入中…' : '補上分類'}
              </Button>
            </div>
          ) : null}
          {archived.length > 0 ? (
            <div>
              <button
                type="button"
                className="text-sm text-[var(--odk-muted)] underline"
                onClick={() => setShowArchived((v) => !v)}
              >
                封存的帳戶（{archived.length}）
              </button>
              {showArchived ? <Section title="" items={archived} /> : null}
            </div>
          ) : null}
        </>
      )}
      {showNew ? <NewAccountDialog onClose={() => setShowNew(false)} /> : null}
      {showNewInvestment ? (
        <NewInvestmentAccountDialog
          onClose={() => setShowNewInvestment(false)}
          onSaved={() => { setShowNewInvestment(false); void reload(); void reloadInvestments(); }}
        />
      ) : null}
    </div>
  );
}

function Section({ title, items, collapsed = false }: { title: string; items: AccountJson[]; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  if (items.length === 0 && title !== '資產' && title !== '信用卡') return null;
  return (
    <section>
      {title ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mb-1 flex w-full items-center justify-between text-xs font-medium text-[var(--odk-muted)]"
        >
          {title}
          <span>{open ? '−' : '+'}</span>
        </button>
      ) : null}
      {open ? (
        items.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--odk-line)] p-3 text-center text-sm text-[var(--odk-muted)]">
            還沒有{title}
          </p>
        ) : (
          <ul className="odk-data-list overflow-hidden rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)]">
            {items.map((account) => {
              const balance = naturalBalance(account);
              const Icon =
                account.subtype === 'category_expense'
                  ? categoryIcon(account.name, 'expense')
                  : account.subtype === 'category_income'
                    ? categoryIcon(account.name, 'income')
                    : null;
              return (
                <li key={account.id}>
                  <a
                    href={`#/accounts/${account.id}`}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--odk-surface-2)]"
                  >
                    {Icon ? <Icon className="h-4 w-4 shrink-0 text-[var(--odk-muted)]" strokeWidth={2.25} /> : null}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{account.name}</div>
                      <div className="text-xs text-[var(--odk-muted)]">
                        {SUBTYPE_LABEL[account.subtype]}
                        {(() => {
                          const org = account.creditCard?.issuer && account.creditCard.issuer !== '—' ? account.creditCard.issuer : account.institution;
                          if (org) return account.name.includes(org) ? '' : ` · ${org}`;
                          // 舊資料沒填銀行 → 給明顯入口，不然「從哪裡付」永遠不知道是哪家
                          if (['bank', 'digital', 'brokerage_settlement'].includes(account.subtype) && isActive(account))
                            return <span className="text-[var(--odk-accent)]"> · 哪家銀行？點進來補</span>;
                          return '';
                        })()}
                        {account.creditCard?.last4 ? ` ·  末四碼 ${isPrivacyMasked() ? '••••' : account.creditCard.last4}` : ''}
                      </div>
                    </div>
                    {account.kind === 'asset' || account.kind === 'liability' ? (
                      <span className={`odk-amount text-sm ${balance.owed ? 'text-[var(--odk-negative)]' : ''}`}>
                        {balance.owed ? `欠 ${balance.text}` : balance.text}
                      </span>
                    ) : null}
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--odk-muted)]" strokeWidth={2} />
                  </a>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </section>
  );
}

// 「投資交割」不在這裡：交割戶要從投資區「＋ 新增投資帳戶」建（自動配對投資資產帳戶）。
// 單獨建的交割戶沒有配對、買賣掛不上去，之前還會在列表隱形。
const NEW_SUBTYPES = ['bank', 'cash', 'digital', 'e_wallet', 'credit_card', 'other_asset', 'other_liability', 'category_expense', 'category_income'];

function NewAccountDialog({ onClose }: { onClose: () => void }) {
  const { accounts, limitGroups, reload } = useAccounts();
  const toast = useToast();
  const [subtype, setSubtype] = useState('bank');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('TWD');
  const [opening, setOpening] = useState('');
  const [busy, setBusy] = useState(false);
  // 信用卡欄位（ACCT-3）
  const [issuer, setIssuer] = useState('');
  const [last4, setLast4] = useState('');
  const [creditLimit, setCreditLimit] = useState('');
  const [limitGroupId, setLimitGroupId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupLimit, setNewGroupLimit] = useState('');
  const [statementDay, setStatementDay] = useState('15');
  const [dueDay, setDueDay] = useState('3');
  const [daysTouched, setDaysTouched] = useState(false);

  const isCard = subtype === 'credit_card';
  const isCategory = subtype.startsWith('category_');
  const isBankLike = subtype === 'bank' || subtype === 'digital' || subtype === 'brokerage_settlement';
  // 銀行存款／數位帳戶／投資交割：選銀行存進 institution，並帶入名稱（可再改）。
  // 同一家銀行已有帳戶時自動加序號（彼岸花銀行 2），不會撞名。
  const [bank, setBank] = useState('');
  const lastSuggestedName = useRef('');
  function pickBank(next: string) {
    setName((current) => {
      if (current.trim() !== '' && current !== lastSuggestedName.current) return current;
      const sameName = accounts.filter((a) => isActive(a) && (a.name === next || a.name.startsWith(`${next} `))).length;
      const suggested = sameName > 0 ? `${next} ${sameName + 1}` : next;
      lastSuggestedName.current = suggested;
      return suggested;
    });
    setBank(next);
  }

  // 同共用額度群組（優先）或同發卡行的既有卡 → 自動帶入結帳日／繳款日。
  // 只在使用者還沒手動改過時帶入——凡事有例外，欄位永遠可以改。
  useEffect(() => {
    if (daysTouched || !isCard) return;
    const cards = accounts.filter((a) => a.creditCard && isActive(a));
    const source =
      (limitGroupId && limitGroupId !== '__new__'
        ? cards.find((a) => a.creditCard?.limitGroupId === limitGroupId)
        : undefined) ?? (issuer ? cards.find((a) => a.creditCard?.issuer === issuer) : undefined);
    if (source?.creditCard) {
      setStatementDay(String(source.creditCard.statementDay));
      setDueDay(String(source.creditCard.dueDay));
      if (!issuer) setIssuer(source.creditCard.issuer);
    }
  }, [accounts, issuer, limitGroupId, daysTouched, isCard]);

  async function save() {
    if (!name.trim()) return toast('輸入名稱', 'error');
    setBusy(true);
    try {
      let groupId = limitGroupId;
      if (isCard && limitGroupId === '__new__') {
        if (!newGroupName || !newGroupLimit) return toast('輸入群組名稱與額度', 'error');
        groupId = newEntityId();
        await mutate('credit_limit_groups', 'create', groupId, {
          name: newGroupName,
          issuer: issuer || newGroupName,
          limitMinor: parseAmount(newGroupLimit, currency).toString(),
        });
      }
      const payload: Record<string, unknown> = { subtype, name: name.trim(), currency };
      if (isBankLike && bank) payload['institution'] = bank;
      // 期初填 0 視同留空：餘額本來就從 0 開始，不建 0 元分錄（schema 也拒收 0）
      const openingMinor = !isCard && !isCategory && opening ? parseAmount(opening, currency) : 0n;
      if (openingMinor > 0n) {
        payload['opening'] = {
          transactionId: newEntityId(),
          amountMinor: openingMinor.toString(),
          isLiability: subtype === 'other_liability',
        };
      }
      if (isCard) {
        if (last4 && !/^\d{4}$/.test(last4)) return toast('末四碼要 4 位數字', 'error');
        payload['creditCard'] = {
          issuer: issuer || '—',
          cardName: name.trim(), // 卡片名稱＝帳戶名稱，不讓使用者填兩次
          last4: last4 || null,
          creditLimitMinor: !groupId && creditLimit ? parseAmount(creditLimit, currency).toString() : null,
          limitGroupId: groupId || null,
          statementDay: Number(statementDay),
          dueDay: Number(dueDay),
          status: 'active',
        };
      }
      await mutate('accounts', 'create', newEntityId(), payload);
      toast('已建立 ✓');
      await reload();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '建立失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="新增帳戶">
      <div className="space-y-3">
        <Field label="類型">
          <Select value={subtype} onChange={(e) => setSubtype(e.target.value)}>
            {NEW_SUBTYPES.map((s) => (
              <option key={s} value={s}>
                {SUBTYPE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        {isBankLike ? <InstitutionSelect label="銀行" options={TAIWAN_BANKS} value={bank} onChange={pickBank} /> : null}
        <Field label="名稱" hint={isBankLike ? '預設用銀行名，可自己改（例如加「薪轉」）' : undefined}>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isCard ? '例：彼岸花銀行 紅蓮卡' : isBankLike ? '例：彼岸花銀行 薪轉' : ''}
          />
        </Field>
        <Field label="幣別">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="TWD">TWD</option>
            <option value="USD">USD</option>
            <option value="JPY">JPY</option>
          </Select>
        </Field>
        {!isCard && !isCategory ? (
          <Field label={subtype === 'other_liability' ? '目前欠款（選填）' : '期初餘額（選填）'}>
            <TextInput inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </Field>
        ) : null}
        {isCard ? (
          <>
            <InstitutionSelect label="發卡行" options={TAIWAN_BANKS} value={issuer} onChange={setIssuer} />
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="末四碼（選填）" hint="只用來在列表裡分辨卡片，不影響記帳與對帳">
                <TextInput inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} />
              </Field>
              <Field label="結帳日" hint="同銀行既有卡片會自動帶入，可以改">
                <TextInput inputMode="numeric" value={statementDay} onChange={(e) => { setDaysTouched(true); setStatementDay(e.target.value); }} />
              </Field>
              <Field label="繳款日">
                <TextInput inputMode="numeric" value={dueDay} onChange={(e) => { setDaysTouched(true); setDueDay(e.target.value); }} />
              </Field>
            </div>
            <Field label="額度" hint="獨立額度填金額；多卡共用選群組（ACCT-4）">
              <Select value={limitGroupId} onChange={(e) => setLimitGroupId(e.target.value)}>
                <option value="">獨立額度</option>
                {limitGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    共用：{g.name}（{formatAmount(g.limitMinor, currency)}）
                  </option>
                ))}
                <option value="__new__">＋ 建立新的共用額度群組</option>
              </Select>
            </Field>
            {limitGroupId === '' ? (
              <Field label="卡片額度（選填）">
                <TextInput inputMode="decimal" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
              </Field>
            ) : null}
            {limitGroupId === '__new__' ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="群組名稱">
                  <TextInput value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} />
                </Field>
                <Field label="群組總額度">
                  <TextInput inputMode="decimal" value={newGroupLimit} onChange={(e) => setNewGroupLimit(e.target.value)} />
                </Field>
              </div>
            ) : null}
          </>
        ) : null}
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

// ---------- 帳戶詳情（信用卡＝週期視圖 F3；F6 記繳款）----------

interface CycleView {
  currency: string;
  current: { periodStart: string; periodEnd: string; statementDate: string; dueDate: string; postedMinor: string; pendingMinor: string; refundedMinor: string };
  previous: { periodStart: string; periodEnd: string; dueDate: string; totalMinor: string; paidMinor: string; unpaidMinor: string };
  outstandingMinor: string;
  availableCreditMinor: string | null;
}

function AccountDetail({ accountId }: { accountId: string }) {
  const { accounts, reload } = useAccounts();
  const toast = useToast();
  const account = accounts.find((a) => a.id === accountId);
  const [cycle, setCycle] = useState<CycleView | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const [showCardEdit, setShowCardEdit] = useState(false);
  const [renameBank, setRenameBank] = useState('');

  const isCard = account?.subtype === 'credit_card';
  const isBankLike = account?.subtype === 'bank' || account?.subtype === 'digital' || account?.subtype === 'brokerage_settlement';

  useEffect(() => {
    if (!isCard) return;
    api
      .get<CycleView>(`/api/cards/${accountId}/cycle`)
      .then(setCycle)
      .catch(() => {});
  }, [accountId, isCard, accounts]);

  if (!account) return <p className="text-[var(--odk-muted)]">找不到帳戶</p>;
  const balance = naturalBalance(account);

  async function toggleArchive() {
    if (!account) return;
    try {
      await mutate('accounts', 'update', account.id, { archived: isActive(account) }, account.version);
      toast(isActive(account) ? '已封存（歷史保留）' : '已取消封存');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '操作失敗', 'error');
    }
  }

  async function rename() {
    if (!account || !newName.trim()) return;
    try {
      const payload: Record<string, unknown> = { name: newName.trim() };
      if (isBankLike) payload['institution'] = renameBank || null;
      await mutate('accounts', 'update', account.id, payload, account.version);
      setRenaming(false);
      toast('已更新 ✓');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '更新失敗', 'error');
    }
  }

  async function remove() {
    if (!account) return;
    try {
      await mutate('accounts', 'delete', account.id, {}, account.version);
      toast('已刪除');
      await reload();
      location.hash = '#/accounts';
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '刪除失敗', 'error');
      setShowDelete(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href="#/accounts" className="text-[var(--odk-muted)]">
          ←
        </a>
        <h1 className="odk-page-title min-w-0 flex-1 truncate text-xl font-semibold">{account.name}</h1>
        <Button
          className="px-2 py-1 text-xs"
          onClick={() => {
            setRenaming(true);
            setNewName(account.name);
            setRenameBank(account.institution ?? TAIWAN_BANKS.find((bank) => account.name.startsWith(bank)) ?? '');
          }}
        >
          {isBankLike ? '編輯' : '改名'}
        </Button>
        {isCard ? (
          <Button className="px-2 py-1 text-xs" onClick={() => setShowCardEdit(true)}>
            編輯卡片
          </Button>
        ) : null}
        <Button className="px-2 py-1 text-xs" onClick={() => void toggleArchive()}>
          {isActive(account) ? '封存' : '取消封存'}
        </Button>
      </div>

      <div className="odk-panel rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)] p-5 text-center">
        <div className="text-xs text-[var(--odk-muted)]">{SUBTYPE_LABEL[account.subtype]}</div>
        <div className={`odk-amount mt-1 text-3xl font-semibold ${balance.owed ? 'text-[var(--odk-negative)]' : ''}`}>
          {balance.owed ? `欠 ${balance.text}` : balance.text}
        </div>
        {isCard && cycle?.availableCreditMinor ? (
          <div className="mt-1 text-xs text-[var(--odk-muted)]">
            可用額度 {formatAmount(cycle.availableCreditMinor, cycle.currency)}
          </div>
        ) : null}
      </div>

      {isBankLike && !account.institution ? (
        <button
          type="button"
          onClick={() => {
            setRenaming(true);
            setNewName(account.name);
            setRenameBank(TAIWAN_BANKS.find((bank) => account.name.startsWith(bank)) ?? '');
          }}
          className="w-full rounded-md bg-[var(--odk-accent-soft)] px-3 py-2 text-left text-sm text-[var(--odk-accent)]"
        >
          還沒設定這個帳戶是哪家銀行——點這裡補上，記帳選帳戶時就會顯示
        </button>
      ) : null}

      {isCard && cycle ? (
        <>
          <section className="odk-panel rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)]">
            <h2 className="border-b border-[var(--odk-line)] px-3 py-2 text-sm font-medium">
              本期（{cycle.current.periodStart} ～ {cycle.current.periodEnd}）
            </h2>
            <dl className="divide-y divide-[var(--odk-line)] text-sm">
              <CycleRow label="已入帳" value={formatAmount(cycle.current.postedMinor, cycle.currency)} />
              <CycleRow label="待入帳" value={formatAmount(cycle.current.pendingMinor, cycle.currency)} />
              {cycle.current.refundedMinor !== '0' ? (
                <CycleRow label="退款" value={`−${formatAmount(cycle.current.refundedMinor, cycle.currency)}`} />
              ) : null}
              <CycleRow label="結帳日" value={cycle.current.statementDate} />
              <CycleRow label="繳款截止" value={cycle.current.dueDate} />
            </dl>
          </section>
          <section className="odk-panel rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)]">
            <h2 className="border-b border-[var(--odk-line)] px-3 py-2 text-sm font-medium">
              上期（{cycle.previous.periodStart} ～ {cycle.previous.periodEnd}）
            </h2>
            <dl className="divide-y divide-[var(--odk-line)] text-sm">
              <CycleRow label="上期消費" value={formatAmount(cycle.previous.totalMinor, cycle.currency)} />
              <CycleRow label="已繳" value={formatAmount(cycle.previous.paidMinor, cycle.currency)} />
              <CycleRow
                label="待繳"
                value={formatAmount(cycle.previous.unpaidMinor, cycle.currency)}
                highlight={cycle.previous.unpaidMinor !== '0'}
              />
            </dl>
          </section>
          <Button variant="primary" className="w-full py-2.5" onClick={() => setShowPayment(true)}>
            記繳款
          </Button>
        </>
      ) : null}

      <a href={`#/transactions`} className="block text-center text-sm text-[var(--odk-muted)] underline">
        看這個帳戶的明細 →
      </a>

      <div className="pt-4">
        <Button variant="danger" className="w-full justify-center py-2" onClick={() => setShowDelete(true)}>
          刪除{isCard ? '這張卡' : '這個帳戶'}
        </Button>
        <p className="mt-1.5 text-center text-xs text-[var(--odk-muted)]">只有還沒有帳務紀錄時能刪除；用過的請改用封存，歷史照常保留</p>
      </div>

      {showPayment && cycle ? (
        <PaymentDialog
          card={account}
          prefillMinor={cycle.previous.unpaidMinor !== '0' ? cycle.previous.unpaidMinor : cycle.outstandingMinor}
          onClose={() => setShowPayment(false)}
          onSaved={() => {
            setShowPayment(false);
            void reload();
          }}
        />
      ) : null}

      {renaming ? (
        <Dialog open onClose={() => setRenaming(false)} title={isBankLike ? '編輯' : '改名'}>
          <div className="space-y-3">
            {isBankLike ? (
              <InstitutionSelect
                label="銀行"
                options={TAIWAN_BANKS}
                value={renameBank}
                onChange={(next) => {
                  setNewName((current) => (current.trim() === '' || current === renameBank ? next : current));
                  setRenameBank(next);
                }}
              />
            ) : null}
            <Field label="名稱" hint={isBankLike ? '選銀行會帶入名稱，可自己改（例如加「薪轉」）' : undefined}>
              <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setRenaming(false)}>取消</Button>
              <Button variant="primary" onClick={() => void rename()}>
                儲存
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}

      {showDelete ? (
        <Dialog open onClose={() => setShowDelete(false)} title={`刪除「${account.name}」？`}>
          <div className="space-y-3 text-sm">
            <p>刪除後就不會出現在任何清單。已經有帳務紀錄的帳戶不能刪，會請你改用封存。</p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setShowDelete(false)}>取消</Button>
              <Button variant="danger" onClick={() => void remove()}>
                刪除
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}

      {showCardEdit && account.creditCard ? (
        <CardEditDialog
          account={account}
          onClose={() => setShowCardEdit(false)}
          onSaved={() => {
            setShowCardEdit(false);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** 編輯卡片資訊（後端 update 早已支援 creditCard 部分更新，這裡補 UI 入口） */
function CardEditDialog({ account, onClose, onSaved }: { account: AccountJson; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const card = account.creditCard!;
  const [issuer, setIssuer] = useState(card.issuer);
  const [last4, setLast4] = useState(card.last4 ?? '');
  const [creditLimit, setCreditLimit] = useState(
    card.creditLimitMinor ? amountToDecimalString(BigInt(card.creditLimitMinor), account.currency) : '',
  );
  const [statementDay, setStatementDay] = useState(String(card.statementDay));
  const [dueDay, setDueDay] = useState(String(card.dueDay));
  const [busy, setBusy] = useState(false);

  async function save() {
    if (last4 && !/^\d{4}$/.test(last4)) return toast('末四碼要 4 位數字', 'error');
    const sd = Number(statementDay);
    const dd = Number(dueDay);
    if (!Number.isInteger(sd) || sd < 1 || sd > 31 || !Number.isInteger(dd) || dd < 1 || dd > 31) {
      return toast('結帳日與繳款截止日要 1–31 的數字', 'error');
    }
    setBusy(true);
    try {
      await mutate(
        'accounts',
        'update',
        account.id,
        {
          creditCard: {
            issuer: issuer.trim() || '—',
            cardName: account.name, // 卡片名稱＝帳戶名稱（改名請用上方的「改名」）
            last4: last4 || null,
            creditLimitMinor: !card.limitGroupId && creditLimit ? parseAmount(creditLimit, account.currency).toString() : null,
            statementDay: sd,
            dueDay: dd,
          },
        },
        account.version,
      );
      toast('卡片資訊已更新 ✓');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '更新失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="編輯卡片資訊">
      <div className="space-y-3">
        <InstitutionSelect label="發卡行" options={TAIWAN_BANKS} value={issuer} onChange={setIssuer} />
        <Field label="末四碼（選填）" hint="只存末四碼、永不儲存完整卡號；清空即移除">
          <TextInput inputMode="numeric" value={last4} onChange={(e) => setLast4(e.target.value.slice(0, 4))} />
        </Field>
        {!card.limitGroupId ? (
          <Field label="信用額度（選填）">
            <TextInput inputMode="decimal" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Field label="結帳日">
            <TextInput inputMode="numeric" value={statementDay} onChange={(e) => setStatementDay(e.target.value)} />
          </Field>
          <Field label="繳款截止日">
            <TextInput inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? '儲存中…' : '儲存'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CycleRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between px-3 py-2">
      <dt className="text-[var(--odk-muted)]">{label}</dt>
      <dd className={`odk-amount ${highlight ? 'font-semibold text-[var(--odk-negative)]' : ''}`}>{value}</dd>
    </div>
  );
}

/** F6 記繳款：轉帳語意（銀行↓、卡債↓），金額預填待繳 */
function PaymentDialog({
  card,
  prefillMinor,
  onClose,
  onSaved,
}: {
  card: AccountJson;
  prefillMinor: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { accounts } = useAccounts();
  const toast = useToast();
  const banks = accounts.filter((a) => a.kind === 'asset' && isActive(a) && a.currency === card.currency);
  const [fromId, setFromId] = useState(banks[0]?.id ?? '');
  const [amount, setAmount] = useState(() =>
    prefillMinor === '0' ? '' : formatPlain(prefillMinor, card.currency),
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!fromId || !amount) return toast('選帳戶、輸入金額', 'error');
    setBusy(true);
    try {
      await mutate('transactions', 'create', newEntityId(), {
        type: 'card_payment',
        amountMinor: parseAmount(amount, card.currency).toString(),
        currency: card.currency,
        fromAccountId: fromId,
        toAccountId: card.id,
        occurredAt: new Date().toISOString(),
        source: 'manual',
      });
      toast('繳款已記錄 ✓（轉帳，不重複算支出）');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '記錄失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`繳款 — ${card.name}`}>
      <div className="space-y-3">
        <Field label={`金額（${card.currency}）`}>
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="付款帳戶">
          <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            記繳款
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** 給輸入框用的純十進位（不含符號與千分位） */
function formatPlain(minorString: string, currency: string): string {
  const value = BigInt(minorString);
  if (value <= 0n) return '';
  return amountToDecimalString(value, currency);
}
