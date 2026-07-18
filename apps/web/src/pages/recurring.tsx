import { amountToDecimalString, parseAmount } from '@okane-dokoitta/domain';
import { Button, Dialog, Field, Segmented, Select, TextInput, useToast } from '@okane-dokoitta/ui';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, mutate, newEntityId } from '../api.js';
import { formatAmount, isActive, useAccounts, type ExpectedJson, type RecurringRuleJson } from '../store.js';
import { useInvestments } from './investments.jsx';

const FREQ_LABEL: Record<string, string> = {
  weekly: '每週',
  monthly: '每月',
  yearly: '每年',
  custom_days: '每 N 天',
};

/** RECUR-1~3、RECUR-5（M1 手動確認）：週期規則與預計交易 */
export function RecurringPage() {
  const { accounts, reload: reloadAccounts } = useAccounts();
  const toast = useToast();
  const [rules, setRules] = useState<RecurringRuleJson[]>([]);
  const [expected, setExpected] = useState<ExpectedJson[]>([]);
  const [editing, setEditing] = useState<RecurringRuleJson | 'new' | null>(null);
  const [confirmingInvest, setConfirmingInvest] = useState<{ item: ExpectedJson; rule: RecurringRuleJson } | null>(null);

  const load = useCallback(async () => {
    const data = await api.get<{ rules: RecurringRuleJson[]; expected: ExpectedJson[] }>('/api/recurring');
    setRules(data.rules);
    setExpected(data.expected);
  }, []);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  async function confirmExpected(item: ExpectedJson) {
    const rule = rules.find((r) => r.id === item.ruleId);
    // 定期定額（圈存）：確認時填實際成交金額與股數
    if (rule?.kind === 'invest_buy') {
      setConfirmingInvest({ item, rule });
      return;
    }
    if (!rule?.categoryAccountId || !item.amountMinor) {
      toast('浮動金額或未設分類的規則，請用「記一筆」手動記帳後略過這筆', 'error');
      return;
    }
    try {
      const txnId = newEntityId();
      await mutate('transactions', 'create', txnId, {
        type: 'expense',
        amountMinor: item.amountMinor,
        currency: item.currency,
        fromAccountId: item.accountId,
        categoryAccountId: rule.categoryAccountId,
        merchantRaw: rule.merchantHint ?? rule.name,
        occurredAt: new Date().toISOString(),
        expectedTransactionId: item.id,
        recurringRuleId: rule.id,
        source: 'recurring',
      });
      await mutate('expected_transactions', 'update', item.id, { status: 'confirmed', matchedTransactionId: txnId }, item.version);
      toast('已確認並記帳 ✓');
      await load();
      void reloadAccounts();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '確認失敗', 'error');
    }
  }

  async function skipExpected(item: ExpectedJson) {
    try {
      await mutate('expected_transactions', 'update', item.id, { status: 'skipped' }, item.version);
      toast('已略過這期');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '略過失敗', 'error');
    }
  }

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="odk-page-title text-xl font-semibold">週期扣款</h1>
        <Button variant="primary" onClick={() => setEditing('new')}>
          ＋ 新增
        </Button>
      </div>

      {expected.length > 0 ? (
        <section>
          <h2 className="mb-1 text-xs font-medium text-[var(--odk-muted)]">預計交易</h2>
          <ul className="odk-data-list overflow-hidden rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)]">
            {expected.map((item) => {
              const rule = rules.find((r) => r.id === item.ruleId);
              const overdue = item.expectedDate < new Date().toISOString().slice(0, 10);
              return (
                <li key={item.id} className="flex items-center gap-2 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{rule?.name ?? '預計交易'}</div>
                    <div className={`text-xs ${overdue ? 'text-[var(--odk-negative)]' : 'text-[var(--odk-muted)]'}`}>
                      {item.expectedDate}
                      {overdue ? '（逾期，還沒看到扣款）' : ''} · {accountName(item.accountId)}
                      {rule?.kind === 'invest_buy' ? ' · 定期定額（先圈存，確認時填實際成交）' : ''}
                    </div>
                  </div>
                  <span className="odk-amount text-sm">
                    {item.amountMinor ? formatAmount(item.amountMinor, item.currency) : '浮動'}
                  </span>
                  <Button className="px-2 py-1 text-xs" onClick={() => void skipExpected(item)}>
                    略過
                  </Button>
                  <Button variant="primary" className="px-2 py-1 text-xs" onClick={() => void confirmExpected(item)}>
                    確認
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="mb-1 text-xs font-medium text-[var(--odk-muted)]">規則</h2>
        {rules.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--odk-line)] p-4 text-center text-sm text-[var(--odk-muted)]">
            訂閱、房租、保費……固定會來的帳，建成規則就不會漏
          </p>
        ) : (
          <ul className="odk-data-list overflow-hidden rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)]">
            {rules.map((rule) => (
              <li key={rule.id}>
                <button
                  type="button"
                  onClick={() => setEditing(rule)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-[var(--odk-surface-2)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      {rule.name}
                      {!rule.active ? <span className="ml-1 text-xs text-[var(--odk-muted)]">（停用）</span> : null}
                    </div>
                    <div className="text-xs text-[var(--odk-muted)]">
                      {FREQ_LABEL[rule.freq]}
                      {rule.dayOfMonth ? ` ${rule.dayOfMonth} 號` : ''} · 下次 {rule.nextExpectedDate} · {accountName(rule.accountId)}
                    </div>
                  </div>
                  <span className="odk-amount">
                    {rule.amountMinor ? formatAmount(rule.amountMinor, rule.currency) : '浮動'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing ? (
        <RuleDialog
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      {confirmingInvest ? (
        <ConfirmInvestDialog
          item={confirmingInvest.item}
          rule={confirmingInvest.rule}
          onClose={() => setConfirmingInvest(null)}
          onSaved={() => {
            setConfirmingInvest(null);
            void load();
            void reloadAccounts();
          }}
        />
      ) : null}
    </div>
  );
}

/** 定期定額確認（Q18 圈存式）：預估額只是圈存，這裡填實際成交金額與股數才入帳。 */
function ConfirmInvestDialog({
  item,
  rule,
  onClose,
  onSaved,
}: {
  item: ExpectedJson;
  rule: RecurringRuleJson;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { securities, loaded } = useInvestments();
  const security = securities.find((s) => s.id === rule.securityId);
  const [amount, setAmount] = useState(item.amountMinor ? amountToDecimalString(BigInt(item.amountMinor), item.currency) : '');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!amount || !quantity) return toast('輸入實際金額與股數', 'error');
    setBusy(true);
    try {
      const txnId = newEntityId();
      await mutate('transactions', 'create', txnId, {
        type: 'invest_buy',
        amountMinor: parseAmount(amount, item.currency).toString(),
        currency: item.currency,
        investmentAccountId: rule.investmentAccountId,
        securityId: rule.securityId,
        quantity,
        merchantRaw: rule.name,
        occurredAt: new Date().toISOString(),
        expectedTransactionId: item.id,
        recurringRuleId: rule.id,
        source: 'recurring',
      });
      await mutate('expected_transactions', 'update', item.id, { status: 'confirmed', matchedTransactionId: txnId }, item.version);
      toast('已確認買入 ✓');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '確認失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`確認買入：${rule.name}`}>
      <div className="space-y-3">
        <p className="text-sm text-[var(--odk-muted)]">
          {loaded && security ? `${security.symbol} ${security.name} · ` : ''}
          圈存 {item.amountMinor ? formatAmount(item.amountMinor, item.currency) : '—'}——照實際成交單改成真的數字
        </p>
        <Field label={`實際金額（${item.currency}）`} hint="含手續費的實付總額">
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="成交股數">
          <TextInput inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="例：13.5" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            確認入帳
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RuleDialog({ rule, onClose, onSaved }: { rule: RecurringRuleJson | null; onClose: () => void; onSaved: () => void }) {
  const { accounts } = useAccounts();
  const { investmentAccounts, securities } = useInvestments();
  const toast = useToast();
  const payAccounts = accounts.filter((a) => isActive(a) && (a.kind === 'asset' || a.subtype === 'credit_card'));
  const categories = accounts.filter((a) => isActive(a) && a.subtype === 'category_expense');

  const [kind, setKind] = useState<'expense' | 'invest_buy'>(rule?.kind ?? 'expense');
  const [investmentAccountId, setInvestmentAccountId] = useState(rule?.investmentAccountId ?? '');
  const [securityId, setSecurityId] = useState(rule?.securityId ?? '');
  const isInvest = kind === 'invest_buy';
  const [name, setName] = useState(rule?.name ?? '');
  const [freq, setFreq] = useState<RecurringRuleJson['freq']>(rule?.freq ?? 'monthly');
  const [dayOfMonth, setDayOfMonth] = useState(String(rule?.dayOfMonth ?? '1'));
  const [month, setMonth] = useState(String(rule?.month ?? '1'));
  const [customDays, setCustomDays] = useState(String(rule?.customEveryDays ?? '30'));
  const [amount, setAmount] = useState(rule?.amountMinor ? amountToDecimalString(BigInt(rule.amountMinor), rule.currency) : '');
  const [accountId, setAccountId] = useState(rule?.accountId ?? payAccounts[0]?.id ?? '');
  const [categoryId, setCategoryId] = useState(rule?.categoryAccountId ?? categories[0]?.id ?? '');
  const [nextDate, setNextDate] = useState(rule?.nextExpectedDate ?? new Date().toISOString().slice(0, 10));
  const [active, setActive] = useState(rule?.active ?? true);
  const [busy, setBusy] = useState(false);

  const currency = isInvest
    ? (investmentAccounts.find((inv) => inv.id === investmentAccountId)?.currency ?? 'TWD')
    : (accounts.find((a) => a.id === accountId)?.currency ?? 'TWD');

  async function save() {
    if (!name.trim()) return toast('輸入名稱', 'error');
    if (isInvest && (!investmentAccountId || !securityId)) return toast('選投資帳戶與標的', 'error');
    if (isInvest && !amount) return toast('定期定額要填預估金額（圈存用）', 'error');
    if (!isInvest && !accountId) return toast('選扣款帳戶', 'error');
    setBusy(true);
    try {
      const schedule: Record<string, unknown> = { freq, interval: 1 };
      if (freq === 'monthly') schedule['dayOfMonth'] = Number(dayOfMonth);
      if (freq === 'yearly') {
        schedule['month'] = Number(month);
        schedule['dayOfMonth'] = Number(dayOfMonth);
      }
      if (freq === 'custom_days') schedule['customEveryDays'] = Number(customDays);
      const payload = {
        name: name.trim(),
        schedule,
        amountMinor: amount ? parseAmount(amount, currency).toString() : null,
        currency,
        amountToleranceMinor: '0',
        dateToleranceDays: 3,
        ...(isInvest
          ? { kind: 'invest_buy', investmentAccountId, securityId, categoryAccountId: null }
          : { kind: 'expense', accountId, categoryAccountId: categoryId || null }),
        merchantHint: null,
        active,
        nextExpectedDate: nextDate,
      };
      if (rule) {
        await mutate('recurring_rules', 'update', rule.id, payload, rule.version);
      } else {
        await mutate('recurring_rules', 'create', newEntityId(), payload);
      }
      toast('已儲存 ✓');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '儲存失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!rule || !window.confirm(`刪除規則「${rule.name}」？`)) return;
    try {
      await mutate('recurring_rules', 'delete', rule.id, {}, rule.version);
      toast('已刪除');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '刪除失敗', 'error');
    }
  }

  return (
    <Dialog open onClose={onClose} title={rule ? '編輯規則' : '新增週期規則'}>
      <div className="space-y-3">
        {!rule ? (
          <Segmented
            options={[
              { value: 'expense' as const, label: '週期支出' },
              { value: 'invest_buy' as const, label: '定期定額' },
            ]}
            value={kind}
            onChange={setKind}
          />
        ) : null}
        <Field label="名稱">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={isInvest ? '例：每月買 0050' : '例：Netflix'} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="週期">
            <Select value={freq} onChange={(e) => setFreq(e.target.value as RecurringRuleJson['freq'])}>
              {Object.entries(FREQ_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          {freq === 'monthly' || freq === 'yearly' ? (
            <Field label="幾號" hint="31 = 月底（小月自動取月底）">
              <TextInput inputMode="numeric" value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} />
            </Field>
          ) : null}
          {freq === 'yearly' ? (
            <Field label="月份">
              <TextInput inputMode="numeric" value={month} onChange={(e) => setMonth(e.target.value)} />
            </Field>
          ) : null}
          {freq === 'custom_days' ? (
            <Field label="每幾天">
              <TextInput inputMode="numeric" value={customDays} onChange={(e) => setCustomDays(e.target.value)} />
            </Field>
          ) : null}
        </div>
        <Field
          label={isInvest ? `每期預估金額（${currency}）` : `金額（${currency}）`}
          hint={isInvest ? '先照這個數字圈存，到期確認時再填實際成交金額與股數' : '留空 = 浮動金額（每期手動記）'}
        >
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {isInvest ? (
          investmentAccounts.length === 0 || securities.length === 0 ? (
            <p className="rounded-md bg-[var(--odk-surface-2)] px-3 py-2 text-sm text-[var(--odk-muted)]">
              先到「投資」頁建立投資帳戶{securities.length === 0 ? '、記一筆買入建立標的' : ''}，回來就能選
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="投資帳戶" hint="從它的交割戶圈存">
                <Select value={investmentAccountId} onChange={(e) => setInvestmentAccountId(e.target.value)}>
                  <option value="">—</option>
                  {investmentAccounts.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="標的">
                <Select value={securityId} onChange={(e) => setSecurityId(e.target.value)}>
                  <option value="">—</option>
                  {securities.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.symbol} {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label="扣款帳戶/卡">
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {payAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="分類">
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">—</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Field label="下次預計日">
          <TextInput type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          啟用
        </label>
        <div className="flex justify-between pt-1">
          {rule ? (
            <Button variant="danger" onClick={() => void remove()}>
              刪除
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              儲存
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
