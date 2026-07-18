import { parseAmount, amountToDecimalString } from '@okane-dokoitta/domain';
import { Button, Dialog, Field, Select, TextInput, useToast } from '@okane-dokoitta/ui';
import { useEffect, useState } from 'react';
import { api, ApiError, mutate } from '../api.js';
import { formatAmount, isActive, useAccounts, type TransactionJson } from '../store.js';

const TYPE_LABEL: Record<string, string> = {
  expense: '支出',
  income: '收入',
  transfer: '轉帳',
  card_payment: '繳款',
  refund: '退款',
  adjustment: '調整',
  invest_buy: '買入',
  invest_sell: '賣出',
  dividend: '股息',
  fee: '手續費',
  tax: '稅',
};

export function TransactionsPage() {
  const { accounts, reload: reloadAccounts } = useAccounts();
  const toast = useToast();
  const [transactions, setTransactions] = useState<TransactionJson[]>([]);
  const [filterAccount, setFilterAccount] = useState('');
  const [editing, setEditing] = useState<TransactionJson | null>(null);

  async function load() {
    const query = filterAccount ? `&accountId=${filterAccount}` : '';
    const data = await api.get<{ transactions: TransactionJson[] }>(`/api/transactions?limit=100${query}`);
    setTransactions(data.transactions);
  }
  useEffect(() => {
    void load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAccount]);

  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? '';

  // 依民用日期分組
  const groups = new Map<string, TransactionJson[]>();
  for (const txn of transactions) {
    const day = txn.occurredAt.slice(0, 10);
    const local = new Date(txn.occurredAt);
    const key = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}` || day;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(txn);
  }

  function amountDisplay(txn: TransactionJson): { text: string; cls: string } {
    const formatted = formatAmount(txn.amountMinor, txn.currency);
    if (txn.type === 'expense' || txn.type === 'fee' || txn.type === 'tax') {
      return { text: `−${formatted}`, cls: 'text-[var(--odk-text)]' };
    }
    if (txn.type === 'income' || txn.type === 'refund' || txn.type === 'dividend') {
      return { text: `+${formatted}`, cls: 'text-[var(--odk-positive)]' };
    }
    return { text: formatted, cls: 'text-[var(--odk-muted)]' };
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="odk-page-title text-xl font-semibold">明細</h1>
        <Select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)} className="w-40">
          <option value="">全部帳戶</option>
          {accounts.filter((a) => isActive(a) && (a.kind === 'asset' || a.kind === 'liability')).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>

      {transactions.length === 0 ? (
        <div className="py-16 text-center text-[var(--odk-muted)]">
          <div className="mb-2 text-3xl">？</div>
          還沒有交易——お金どこいった？
        </div>
      ) : (
        [...groups.entries()].map(([day, items]) => (
          <section key={day}>
            <h2 className="sticky top-0 bg-[var(--odk-bg)] py-1 text-xs font-medium text-[var(--odk-muted)]">{day}</h2>
            <ul className="odk-data-list overflow-hidden rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)]">
              {items.map((txn) => {
                const amount = amountDisplay(txn);
                return (
                  <li key={txn.id}>
                    <button
                      type="button"
                      onClick={() => setEditing(txn)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--odk-surface-2)]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          {txn.merchantRaw || txn.note || TYPE_LABEL[txn.type] || txn.type}
                          {txn.status === 'pending' ? <span className="ml-1.5 text-xs text-[var(--odk-muted)]">待入帳</span> : null}
                          {txn.needsReview ? <span className="ml-1.5 text-xs text-[var(--odk-signal)]">分類待複核</span> : null}
                        </div>
                        <div className="truncate text-xs text-[var(--odk-muted)]">
                          {TYPE_LABEL[txn.type]}
                          {txn.categoryAccountId ? ` · ${accountName(txn.categoryAccountId)}` : ''}
                          {' · '}
                          {txn.type === 'income' || txn.type === 'refund' || txn.type === 'dividend'
                            ? accountName(txn.toAccountId)
                            : accountName(txn.fromAccountId)}
                          {txn.type === 'transfer' || txn.type === 'card_payment' ? ` → ${accountName(txn.toAccountId)}` : ''}
                        </div>
                      </div>
                      <span className={`odk-amount text-sm ${amount.cls}`}>{amount.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {editing ? (
        <EditDialog
          txn={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
            void reloadAccounts();
          }}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

function EditDialog({
  txn,
  onClose,
  onSaved,
  toast,
}: {
  txn: TransactionJson;
  onClose: () => void;
  onSaved: () => void;
  toast: (msg: string, kind?: 'ok' | 'error') => void;
}) {
  const { accounts } = useAccounts();
  const [amount, setAmount] = useState(() => amountToDecimalString(BigInt(txn.amountMinor), txn.currency));
  const [merchant, setMerchant] = useState(txn.merchantRaw ?? '');
  const [note, setNote] = useState(txn.note ?? '');
  const [categoryId, setCategoryId] = useState(txn.categoryAccountId ?? '');
  const [busy, setBusy] = useState(false);

  const isExpenseLike = txn.type === 'expense' || txn.type === 'fee' || txn.type === 'tax';
  const categories = accounts.filter(
    (a) => a.subtype === (txn.type === 'income' ? 'category_income' : 'category_expense') && isActive(a),
  );

  async function save() {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        amountMinor: parseAmount(amount, txn.currency).toString(),
        merchantRaw: merchant || null,
        note: note || null,
        needsReview: false,
      };
      if ((isExpenseLike || txn.type === 'income') && categoryId) payload['categoryAccountId'] = categoryId;
      await mutate('transactions', 'update', txn.id, payload, txn.version);
      toast('已更新 ✓');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '更新失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('刪除這筆交易？（軟刪除，餘額會回復）')) return;
    setBusy(true);
    try {
      await mutate('transactions', 'delete', txn.id, {}, txn.version);
      toast('已刪除');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '刪除失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`編輯${TYPE_LABEL[txn.type] ?? '交易'}`}>
      <div className="space-y-3">
        <Field label={`金額（${txn.currency}）`}>
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {isExpenseLike || txn.type === 'income' ? (
          <Field label="分類">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="商家">
          <TextInput value={merchant} onChange={(e) => setMerchant(e.target.value)} />
        </Field>
        <Field label="備註">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex justify-between pt-1">
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>
            刪除
          </Button>
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
