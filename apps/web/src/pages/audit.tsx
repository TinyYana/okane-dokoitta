import { Button, Field, TextInput, useToast } from '@okane-dokoitta/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.js';
import { formatAmount, isPrivacyMasked } from '../store.js';

interface Account {
  id: string;
  name: string;
  subtype: string;
  archivedAt?: string | null;
  creditCard?: { last4: string | null; issuer: string } | null;
}

interface AuditListRow {
  session: { id: string; status: string; stats: Record<string, unknown>; createdAt: string };
  statement: { statementDate: string; totalMinor: string; currency: string; creditCardAccountId: string; groupId: string | null };
  group: { id: string; institution: string; statementDate: string; totalMinor: string; currency: string } | null;
}

interface AuditDetail {
  session: { id: string; status: string; stats: Record<string, unknown> };
  statement: { id: string; statementDate: string; totalMinor: string; currency: string };
  group: { totalMinor: string; currency: string } | null;
  file: { id: string; filename: string; status: string } | null;
  items: Array<{
    id: string;
    lineNo: number;
    merchantRaw: string;
    amountMinor: string;
    currency: string;
    occurredDate: string | null;
    postedDate: string | null;
    installmentCurrent: number | null;
    installmentTotal: number | null;
  }>;
  candidates: Array<{
    id: string;
    statementItemId: string | null;
    transactionId: string | null;
    kind: string;
    score: string;
    reasoningCodes: string[];
    explanation: string;
    decision: string;
    evidence: Record<string, unknown>;
  }>;
  patches: Array<{
    id: string;
    candidateId: string | null;
    kind: string;
    status: string;
    failureCode: string | null;
    payload: Record<string, unknown>;
  }>;
}

interface AiReview {
  summary: string;
  candidateOrder: string[];
  reviewedCount: number;
  totalCandidates: number;
}

type AiAvailability = 'loading' | 'enabled' | 'disabled' | 'error';

function useAiAvailability(): AiAvailability {
  const [availability, setAvailability] = useState<AiAvailability>('loading');
  useEffect(() => {
    api
      .get<{ enabled: boolean }>('/api/ai/settings')
      .then((settings) => setAvailability(settings.enabled ? 'enabled' : 'disabled'))
      .catch(() => setAvailability('error'));
  }, []);
  return availability;
}

function AiAvailabilityHint({ availability }: { availability: AiAvailability }) {
  if (availability === 'enabled') return null;
  return (
    <p className="text-xs text-[var(--odk-muted)]">
      {availability === 'loading' ? '正在確認 AI 設定…' : availability === 'error' ? 'AI 設定目前無法載入。' : 'AI 輔助尚未啟用。'}
      {availability !== 'loading' ? <>{' '}<a href="#/settings" className="text-[var(--odk-accent)] hover:underline">前往設定</a></> : null}
    </p>
  );
}

export function AuditPage({ route }: { route: string }) {
  const sessionId = route.startsWith('/audit/') ? route.slice('/audit/'.length) : null;
  return sessionId ? <AuditSession sessionId={sessionId} /> : <AuditHome />;
}

function AuditHome() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessions, setSessions] = useState<AuditListRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'csv' | 'text'>('csv');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('statement.csv');
  const [cardId, setCardId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [statementDate, setStatementDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [total, setTotal] = useState('');
  const [merchantColumn, setMerchantColumn] = useState('merchant');
  const [amountColumn, setAmountColumn] = useState('amount');
  const [occurredColumn, setOccurredColumn] = useState('date');
  const aiAvailability = useAiAvailability();
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSourceText, setAiSourceText] = useState<string | null>(null);

  // AI 欄位抽取（M6）：髒文字 → 逐行格式，結果貼回輸入框給使用者過目，走同一條匯入管線
  async function aiTidy() {
    setAiBusy(true);
    try {
      const result = await api.post<{ text: string }>('/api/ai/extract-statement', { text });
      if (!result.text) return toast('AI 沒抓到可用的交易行', 'error');
      setAiSourceText((current) => current ?? text);
      setText(result.text);
      setKind('text');
      toast('AI 整理稿已產生——原文會另外保留，請確認後再開始審計', 'ok');
    } catch (error) {
      toast(messageOf(error, 'AI 整理失敗'), 'error');
    } finally {
      setAiBusy(false);
    }
  }

  const load = useCallback(async () => {
    const [accountResult, sessionResult] = await Promise.all([
      api.get<{ accounts: Account[] }>('/api/accounts'),
      api.get<{ sessions: AuditListRow[] }>('/api/audit/sessions'),
    ]);
    const cards = accountResult.accounts.filter((account) => account.subtype === 'credit_card');
    setAccounts(cards);
    setCardId((current) => current || cards[0]?.id || '');
    setSessions(sessionResult.sessions);
  }, []);

  useEffect(() => { void load().catch((error) => toast(messageOf(error, '無法載入審計資料'), 'error')); }, [load, toast]);

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 5_000_000) return toast('檔案超過 5 MB 上限', 'error');
    setFilename(file.name);
    setKind(file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'text');
    setText(await file.text());
    setAiSourceText(null);
  }

  async function submit() {
    if (!cardId) return toast('請先建立信用卡帳戶', 'error');
    setBusy(true);
    try {
      const result = await api.post<{ sessionId: string; sessions?: Array<{ sessionId: string }>; warnings: unknown[] }>('/api/audit/import', {
        kind,
        text,
        ...(aiSourceText ? { sourceText: aiSourceText } : {}),
        filename,
        importerId: 'auto',
        creditCardAccountId: cardId,
        ...(kind === 'csv' ? { columns: { merchant: merchantColumn, amount: amountColumn, occurredAt: occurredColumn } } : {}),
        defaults: {
          currency: 'TWD',
          ...(periodStart ? { periodStart } : {}),
          ...(periodEnd ? { periodEnd } : {}),
          ...(statementDate ? { statementDate } : {}),
          ...(dueDate ? { dueDate } : {}),
          ...(total ? { total } : {}),
        },
      });
      if ((result.sessions?.length ?? 1) > 1) toast(`已依卡片建立 ${result.sessions!.length} 個審計工作階段`, 'ok');
      else if (result.warnings.length) toast(`匯入完成，另有 ${result.warnings.length} 則可追蹤警告`, 'ok');
      location.hash = `#/audit/${result.sessionId}`;
    } catch (error) {
      toast(messageOf(error, '匯入失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const history: Array<
    | { kind: 'single'; row: AuditListRow }
    | { kind: 'group'; group: NonNullable<AuditListRow['group']>; rows: AuditListRow[] }
  > = [];
  const groups = new Map<string, Extract<(typeof history)[number], { kind: 'group' }>>();
  for (const row of sessions) {
    if (!row.group) {
      history.push({ kind: 'single', row });
      continue;
    }
    const existing = groups.get(row.group.id);
    if (existing) existing.rows.push(row);
    else {
      const entry = { kind: 'group' as const, group: row.group, rows: [row] };
      groups.set(row.group.id, entry);
      history.push(entry);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="odk-page-title text-2xl font-semibold">對帳</h1>
        <p className="mt-1 text-sm text-[var(--odk-muted)]">匯入帳單後逐筆核對，修正前一定會先問你</p>
      </div>

      <section className="space-y-5 rounded-2xl bg-[var(--odk-surface-2)] p-5">
        <h2 className="font-semibold">匯入這期帳單</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="信用卡">
            <select className="min-h-10 w-full rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)] px-3 text-sm" value={cardId} onChange={(event) => setCardId(event.target.value)}>
              <option value="">選擇卡片</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.creditCard?.last4 ? ` • ${account.creditCard.last4}` : ''}</option>)}
            </select>
          </Field>
          <Field label="CSV 或文字檔">
            <input className="block w-full text-sm" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => void readFile(event.target.files?.[0])} />
          </Field>
          <Field label="帳單期間開始（銀行格式可自動帶入）"><TextInput type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></Field>
          <Field label="帳單期間結束（銀行格式可自動帶入）"><TextInput type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></Field>
          <Field label="帳單日（銀行格式可自動帶入）"><TextInput type="date" value={statementDate} onChange={(event) => setStatementDate(event.target.value)} /></Field>
          <Field label="繳款截止日（銀行格式可自動帶入）"><TextInput type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></Field>
          <Field label="帳單聲稱總額（TWD，可自動帶入）"><TextInput inputMode="numeric" value={total} onChange={(event) => setTotal(event.target.value)} /></Field>
        </div>
        {kind === 'csv' ? (
          <details className="border-y border-[var(--odk-line)] py-3 text-sm">
            <summary className="cursor-pointer font-medium">CSV 欄位對應</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="商家欄名"><TextInput value={merchantColumn} onChange={(event) => setMerchantColumn(event.target.value)} /></Field>
              <Field label="金額欄名"><TextInput value={amountColumn} onChange={(event) => setAmountColumn(event.target.value)} /></Field>
              <Field label="日期欄名"><TextInput value={occurredColumn} onChange={(event) => setOccurredColumn(event.target.value)} /></Field>
            </div>
          </details>
        ) : null}
        <Field label={kind === 'csv' ? 'CSV 內容' : '逐行文字（日期 | 商家 | 金額）'}>
          <textarea className="min-h-44 w-full rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)] p-3 font-mono text-xs" required value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
        {aiSourceText ? (
          <details className="border-y border-[var(--odk-line)] py-3 text-sm">
            <summary className="cursor-pointer font-medium">比較 AI 整理前原文</summary>
            <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--odk-surface)] p-3 font-mono text-xs">{isPrivacyMasked() ? '隱私遮蔽已開啟' : aiSourceText}</pre>
            <Button className="mt-3" onClick={() => { setText(aiSourceText); setAiSourceText(null); }}>
              捨棄 AI 整理稿
            </Button>
          </details>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || !text} onClick={() => void submit()}>
            {busy ? '解析與配對中…' : '開始審計'}
          </Button>
          {aiAvailability === 'enabled' ? (
            <Button disabled={aiBusy || !text} onClick={() => void aiTidy()}>
              {aiBusy ? 'AI 整理中…' : 'AI 幫我整理成逐行格式'}
            </Button>
          ) : null}
        </div>
        <AiAvailabilityHint availability={aiAvailability} />
        <p className="text-xs leading-5 text-[var(--odk-muted)]">聯邦銀行 CSV 會依末四碼自動拆成每張卡的審計，銀行合併應繳總額仍保留在同一帳單群組；請先在卡片設定填好末四碼<br />通用 CSV／文字格式請手動補齊帳單資料；PDF 目前只讀文字層</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-bold tracking-[0.12em] text-[var(--odk-muted)]">歷史審計</h2>
        <div className="divide-y divide-[var(--odk-line)] border-y border-[var(--odk-line)]">
          {history.map((entry) => {
            if (entry.kind === 'single') {
              const { session, statement } = entry.row;
              const account = accounts.find((item) => item.id === statement.creditCardAccountId);
              return (
                <a key={session.id} href={`#/audit/${session.id}`} className="flex items-center justify-between gap-4 py-3 text-sm hover:text-[var(--odk-accent)]">
                  <div><div className="font-medium">{statement.statementDate} · {account?.name ?? '信用卡'}</div><div className="text-xs text-[var(--odk-muted)]">{statusLabel(session.status)}</div></div>
                  <div className="font-mono">{statement.totalMinor} {statement.currency}</div>
                </a>
              );
            }
            return (
              <div key={entry.group.id} className="py-3">
                <div className="flex items-center justify-between gap-4 text-sm">
                  <div><div className="font-semibold">{entry.group.institution}</div><div className="text-xs text-[var(--odk-muted)]">{entry.group.statementDate} · 合併帳單</div></div>
                  <div className="text-right"><div className="font-mono">{entry.group.totalMinor} {entry.group.currency}</div><div className="text-[10px] text-[var(--odk-muted)]">銀行合併應繳</div></div>
                </div>
                <div className="ml-3 mt-2 border-l border-[var(--odk-line)] pl-3">
                  {entry.rows.map(({ session, statement }) => {
                    const account = accounts.find((item) => item.id === statement.creditCardAccountId);
                    return (
                      <a key={session.id} href={`#/audit/${session.id}`} className="flex items-center justify-between gap-4 py-2 text-sm hover:text-[var(--odk-accent)]">
                        <div><div>{account?.name ?? '信用卡'}{account?.creditCard?.last4 ? ` • ${account.creditCard.last4}` : ''}</div><div className="text-xs text-[var(--odk-muted)]">{statusLabel(session.status)}</div></div>
                        <div className="text-right"><div className="font-mono">{statement.totalMinor} {statement.currency}</div><div className="text-[10px] text-[var(--odk-muted)]">本卡明細小計</div></div>
                      </a>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!sessions.length ? <p className="py-5 text-sm text-[var(--odk-muted)]">還沒有對帳紀錄</p> : null}
        </div>
      </section>
    </div>
  );
}

function AuditSession({ sessionId }: { sessionId: string }) {
  const toast = useToast();
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const aiAvailability = useAiAvailability();
  const [aiExplains, setAiExplains] = useState<Record<string, string>>({});
  const [aiReview, setAiReview] = useState<AiReview | null>(null);
  const [aiReviewBusy, setAiReviewBusy] = useState(false);
  const load = useCallback(async () => {
    const [nextDetail, accountResult] = await Promise.all([
      api.get<AuditDetail>(`/api/audit/sessions/${sessionId}`),
      api.get<{ accounts: Account[] }>('/api/accounts'),
    ]);
    setDetail(nextDetail);
    setAccounts(accountResult.accounts);
    setAiReview(null);
  }, [sessionId]);
  useEffect(() => { void load().catch((error) => toast(messageOf(error, '無法載入審計'), 'error')); }, [load, toast]);
  const patches = useMemo(() => new Map(detail?.patches.map((patch) => [patch.candidateId, patch]) ?? []), [detail]);

  // AI 證據轉白話（M6）：只顯示，不進資料庫
  async function explainWithAi(candidateId: string) {
    setAiExplains((current) => ({ ...current, [candidateId]: '…' }));
    try {
      const result = await api.post<{ explanation: string }>('/api/ai/explain', { sessionId, candidateId });
      setAiExplains((current) => ({ ...current, [candidateId]: result.explanation }));
    } catch (error) {
      setAiExplains((current) => { const { [candidateId]: _dropped, ...rest } = current; return rest; });
      toast(messageOf(error, 'AI 解釋失敗'), 'error');
    }
  }

  async function reviewWithAi() {
    setAiReviewBusy(true);
    try {
      setAiReview(await api.post<AiReview>('/api/ai/review-session', { sessionId }));
    } catch (error) {
      toast(messageOf(error, 'AI 審計重點整理失敗'), 'error');
    } finally {
      setAiReviewBusy(false);
    }
  }

  async function decide(candidate: AuditDetail['candidates'][number], accept: boolean) {
    try {
      const patch = patches.get(candidate.id);
      if (!patch || (accept ? patch.status !== 'proposed' : !['proposed', 'failed'].includes(patch.status))) throw new Error('候選項目缺少可處理的修正提案');
      const categoryOverride = patch.kind === 'create_transaction' ? categoryOverrides[patch.id] : undefined;
      const categoryAccountId = patch.kind === 'create_transaction'
        ? categoryOverride ?? payloadString(patch.payload, 'categoryAccountId')
        : undefined;
      if (accept && patch.kind === 'create_transaction' && !categoryAccountId) throw new Error('請先選擇分類');
      await api.post(`/api/audit/patches/${patch.id}/decision`, { accept, ...(categoryOverride ? { categoryAccountId: categoryOverride } : {}) });
      await load();
    } catch (error) {
      toast(messageOf(error, '無法儲存決定'), 'error');
    }
  }

  async function acceptAllStatementDrafts() {
    if (!detail) return;
    const drafts = detail.patches.filter((patch) => patch.kind === 'create_transaction' && patch.status === 'proposed');
    const missing = drafts.filter((patch) => !(categoryOverrides[patch.id] ?? payloadString(patch.payload, 'categoryAccountId')));
    if (missing.length) {
      toast(`還有 ${missing.length} 筆缺少分類，請先逐筆選擇`, 'error');
      return;
    }
    const reviewCount = drafts.filter((patch) => patch.payload['needsReview'] === true && !categoryOverrides[patch.id]).length;
    const reviewText = reviewCount ? `其中 ${reviewCount} 筆會先歸到「其他支出」並標成分類待複核。` : '';
    if (!window.confirm(`要把 ${drafts.length} 筆帳單明細加入帳本嗎？${reviewText}`)) return;
    setBatchBusy(true);
    let failed = 0;
    for (const patch of drafts) {
      const categoryAccountId = categoryOverrides[patch.id];
      try {
        await api.post(`/api/audit/patches/${patch.id}/decision`, { accept: true, ...(categoryAccountId ? { categoryAccountId } : {}) });
      } catch {
        failed += 1;
      }
    }
    await load();
    setBatchBusy(false);
    toast(failed ? `${drafts.length - failed} 筆已加入，${failed} 筆失敗，請查看逐筆結果` : `${drafts.length} 筆已加入帳本`, failed ? 'error' : 'ok');
  }

  async function complete() {
    try {
      await api.post(`/api/audit/sessions/${sessionId}/complete`);
      await load();
      toast('審計已封存；未解差額仍保留在報告中', 'ok');
    } catch (error) {
      toast(messageOf(error, '無法完成審計'), 'error');
    }
  }

  if (!detail) return <p className="text-sm text-[var(--odk-muted)]">載入審計訊號…</p>;
  const stats = detail.session.stats;
  const currency = detail.group?.currency ?? detail.statement.currency;
  const differenceMinor = String(stats['differenceMinor'] ?? '0');
  const pendingCount = detail.candidates.filter((candidate) => candidate.decision === 'pending').length;
  const decidedCount = detail.candidates.length - pendingCount;
  const items = new Map(detail.items.map((item) => [item.id, item]));
  const defaultCandidates = [...detail.candidates].sort((left, right) =>
    Number(left.kind === 'unresolved_difference') - Number(right.kind === 'unresolved_difference'),
  );
  const aiOrder = new Map(aiReview?.candidateOrder.map((id, index) => [id, index]) ?? []);
  const candidates = aiReview
    ? [...defaultCandidates].sort((left, right) => (aiOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (aiOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
    : defaultCandidates;
  const statementDrafts = detail.patches.filter((patch) => patch.kind === 'create_transaction' && patch.status === 'proposed');
  const missingDraftCategories = statementDrafts.filter((patch) => !(categoryOverrides[patch.id] ?? payloadString(patch.payload, 'categoryAccountId'))).length;
  return (
    <div className="space-y-7">
      <a href="#/audit" className="text-sm text-[var(--odk-muted)] hover:text-[var(--odk-accent)]">← 回帳單審計</a>
      <div>
        <p className="text-sm text-[var(--odk-muted)]">{statusLabel(detail.session.status)}</p>
        <h1 className="odk-page-title mt-1 text-2xl font-semibold">{detail.statement.statementDate} 帳單</h1>
      </div>
      <section aria-labelledby="audit-result-heading" className="border-y border-[var(--odk-line)] py-5">
        <p className="text-xs font-bold tracking-[0.12em] text-[var(--odk-muted)]">審計結論</p>
        <h2 id="audit-result-heading" className={`mt-2 text-xl font-semibold ${differenceMinor === '0' ? 'text-[var(--odk-positive)]' : 'text-[var(--odk-signal)]'}`}>
          {differenceMessage(differenceMinor, currency)}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--odk-muted)]">
          {pendingCount > 0
            ? `還有 ${pendingCount} 項需要你判斷。逐筆確認後，系統才會封存這份審計。`
            : '所有項目都已判斷，可以封存這份審計報告。'}
        </p>
      </section>
      <div className="grid grid-cols-2 gap-px bg-[var(--odk-line)] border border-[var(--odk-line)] sm:grid-cols-4">
        <Stat label="帳單總額" value={formatAmount(String(stats['statementTotalMinor'] ?? detail.statement.totalMinor), currency)} />
        <Stat label="已配對金額" value={formatAmount(String(stats['ledgerExpectedMinor'] ?? '0'), currency)} />
        <Stat label="尚未對上" value={formatAmount(differenceMinor, currency)} signal={differenceMinor !== '0'} />
        <Stat label="自動配對" value={`${String(stats['automaticMatches'] ?? 0)} 筆`} />
      </div>
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-semibold">逐筆確認</h2>
            <p className="mt-1 text-xs text-[var(--odk-muted)]">已處理 {decidedCount} / {detail.candidates.length} 項</p>
          </div>
          {pendingCount > 0 ? <span className="text-sm font-medium text-[var(--odk-signal)]">待確認 {pendingCount} 項</span> : null}
        </div>
        <AiAvailabilityHint availability={aiAvailability} />
        {aiAvailability === 'enabled' ? (
          <Button disabled={aiReviewBusy} onClick={() => void reviewWithAi()}>
            {aiReviewBusy ? 'AI 整理審計重點中…' : 'AI 幫我整理審計重點'}
          </Button>
        ) : null}
        {aiReview ? (
          <div className="border-l-2 border-[var(--odk-accent)] pl-3">
            <p className="text-xs font-bold text-[var(--odk-accent)]">AI 審計重點</p>
            <p className="mt-1 text-sm leading-6 text-[var(--odk-text)]">{aiReview.summary}</p>
            <p className="mt-1 text-xs text-[var(--odk-muted)]">
              AI 只調整畫面上的複核順序，不會改分數、接受提案或寫入帳本{aiReview.reviewedCount < aiReview.totalCandidates ? `；本次先整理 ${aiReview.reviewedCount} / ${aiReview.totalCandidates} 項` : ''}。
            </p>
          </div>
        ) : null}
        {statementDrafts.length ? (
          <div className="flex flex-col gap-3 border-y border-[var(--odk-line)] py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">帳單可以直接補成記帳</p>
              <p className="mt-1 text-xs text-[var(--odk-muted)]">
                共 {statementDrafts.length} 筆；系統會保留原始帳單連結，未知分類之後仍可在交易列表複核。
              </p>
            </div>
            <Button variant="primary" disabled={batchBusy || missingDraftCategories > 0} onClick={() => void acceptAllStatementDrafts()}>
              {batchBusy ? '加入中…' : `將 ${statementDrafts.length} 筆加入帳本`}
            </Button>
          </div>
        ) : null}
        <div className="divide-y divide-[var(--odk-line)] border-y border-[var(--odk-line)]">
          {candidates.map((candidate, index) => {
            const item = candidate.statementItemId ? items.get(candidate.statementItemId) : undefined;
            const merchant = item?.merchantRaw || evidenceString(candidate.evidence, 'merchantRaw') || (candidate.kind === 'unresolved_difference' ? '整份帳單差額' : '未命名交易');
            const amountMinor = item?.amountMinor ?? evidenceString(candidate.evidence, 'amountMinor');
            const patch = patches.get(candidate.id);
            const confidence = Math.round(Number(candidate.score) * 100);
            return (
              <article key={candidate.id} className={`py-5 ${candidate.kind === 'unresolved_difference' ? 'text-[var(--odk-signal)]' : ''}`}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-xs text-[var(--odk-muted)]">#{String(index + 1).padStart(2, '0')}</span>
                      <span className="text-xs font-bold text-[var(--odk-accent)]">{candidateKindLabel(candidate.kind)}</span>
                      <span className="text-xs text-[var(--odk-muted)]">
                        {confidenceLabel(candidate.kind, confidence)}
                      </span>
                    </div>
                    <h3 className="mt-2 text-lg font-semibold text-[var(--odk-text)]">{merchant}</h3>
                    <p className="mt-1 text-sm text-[var(--odk-muted)]">
                      {[item?.occurredDate ?? item?.postedDate, item ? `帳單第 ${item.lineNo} 筆` : null, installmentLabel(item)].filter(Boolean).join(' · ') || '帳務差異摘要'}
                    </p>
                    <p className="mt-3 text-sm leading-6 text-[var(--odk-text)]">{candidate.explanation}</p>
                    {patch?.kind === 'create_transaction' && candidate.decision === 'pending' ? (
                      <label className="mt-3 block max-w-sm text-xs font-medium text-[var(--odk-muted)]">
                        記到哪個分類
                        <select
                          className="mt-1 w-full rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)] px-3 py-2 text-sm text-[var(--odk-text)]"
                          value={categoryOverrides[patch.id] ?? payloadString(patch.payload, 'categoryAccountId') ?? ''}
                          onChange={(event) => setCategoryOverrides((current) => ({ ...current, [patch.id]: event.target.value }))}
                        >
                          <option value="">請選擇分類</option>
                          {accounts
                            .filter((account) => !account.archivedAt && account.subtype === (patch.payload['transactionType'] === 'income' ? 'category_income' : 'category_expense'))
                            .map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                        </select>
                        {patch.payload['needsReview'] === true && !categoryOverrides[patch.id]
                          ? <span className="mt-1 block text-[var(--odk-signal)]">目前是保底分類，加入後會標示「分類待複核」</span>
                          : null}
                      </label>
                    ) : null}
                    {aiExplains[candidate.id] ? (
                      <p className="mt-2 border-l-2 border-[var(--odk-accent)] pl-3 text-sm text-[var(--odk-muted)]">{aiExplains[candidate.id]}</p>
                    ) : aiAvailability === 'enabled' ? (
                      <button type="button" className="mt-2 text-xs text-[var(--odk-accent)]" onClick={() => void explainWithAi(candidate.id)}>
                        用 AI 解釋這個判斷
                      </button>
                    ) : null}
                  </div>
                  {amountMinor ? <div className="odk-amount shrink-0 text-xl font-semibold text-[var(--odk-text)]">{formatAmount(amountMinor, item?.currency ?? currency)}</div> : null}
                </div>

                <details className="mt-3 text-xs text-[var(--odk-muted)]">
                  <summary className="cursor-pointer select-none hover:text-[var(--odk-accent)]">技術證據</summary>
                  <div className="mt-2 space-y-1 border-l border-[var(--odk-line)] pl-3">
                    <p>類型：<code>{candidate.kind}</code></p>
                    <p>候選 ID：<code className="odk-break-anywhere">{candidate.id}</code></p>
                    {candidate.statementItemId ? <p>帳單明細 ID：<code className="odk-break-anywhere">{candidate.statementItemId}</code></p> : null}
                    {candidate.transactionId ? <p>帳本交易 ID：<code className="odk-break-anywhere">{candidate.transactionId}</code></p> : null}
                    {candidate.reasoningCodes.length ? <p>判斷代碼：<code>{candidate.reasoningCodes.join(', ')}</code></p> : null}
                    <pre className="odk-break-anywhere whitespace-pre-wrap font-mono">{isPrivacyMasked() ? '隱私遮蔽已開啟' : JSON.stringify(candidate.evidence, null, 2)}</pre>
                  </div>
                </details>

                {candidate.decision === 'pending' ? (
                  patch?.status === 'failed'
                    ? <div className="mt-4"><p className="mb-2 text-xs text-[var(--odk-signal)]">提案套用失敗：{patch.failureCode ?? 'UNKNOWN'}</p><Button onClick={() => void decide(candidate, false)}>關閉失敗提案</Button></div>
                    : <div className="mt-4"><div className="flex flex-wrap gap-2"><Button variant="primary" onClick={() => void decide(candidate, true)}>{primaryDecisionLabel(patch?.kind)}</Button><Button onClick={() => void decide(candidate, false)}>{secondaryDecisionLabel(patch?.kind)}</Button></div>{patch?.kind === 'acknowledge_unresolved' ? <p className="mt-2 text-xs text-[var(--odk-muted)]">保留未解只會留下審計紀錄，不會自動新增或修改帳本。</p> : null}</div>
                ) : <p className="mt-4 text-xs font-medium text-[var(--odk-muted)]">已{candidate.decision === 'accepted' ? '接受這項處理' : '排除這項提案'}</p>}
              </article>
            );
          })}
        </div>
        {!detail.candidates.length ? <p className="py-5 text-sm text-[var(--odk-muted)]">沒有需要人工判斷的項目。</p> : null}
      </section>
      {detail.session.status === 'reviewing' ? <Button variant="primary" className="w-full" disabled={pendingCount > 0} onClick={() => void complete()}>{pendingCount > 0 ? `先處理剩下 ${pendingCount} 項` : '完成並保留審計報告'}</Button> : null}
      {detail.file && detail.file.status !== 'purged' ? (
        <Button variant="danger" onClick={() => void api.post(`/api/audit/files/${detail.file!.id}/purge`).then(load)}>刪除加密原始檔（解析結果保留）</Button>
      ) : null}
    </div>
  );
}

function Stat({ label, value, signal = false }: { label: string; value: string; signal?: boolean }) {
  return <div className="bg-[var(--odk-surface)] p-4"><div className="text-[10px] font-bold tracking-[0.1em] text-[var(--odk-muted)]">{label}</div><div className={`odk-amount mt-1 text-lg ${signal ? 'text-[var(--odk-signal)]' : ''}`}>{value}</div></div>;
}

function differenceMessage(minor: string, currency: string): string {
  const difference = BigInt(minor);
  if (difference === 0n) return '帳單和帳本已經對上';
  const amount = formatAmount((difference < 0n ? -difference : difference).toString(), currency);
  return difference > 0n ? `帳單還有 ${amount} 沒對上` : `帳本比帳單多出 ${amount}`;
}

function candidateKindLabel(kind: string): string {
  return ({
    match: '找到可配對紀錄',
    missing_in_ledger: '帳單有，帳本找不到',
    missing_in_statement: '帳本有，帳單找不到',
    amount_mismatch: '金額不同',
    date_mismatch: '日期不同',
    wrong_card: '可能選錯卡片',
    duplicate: '可能重複',
    refund_unlinked: '退款缺少原交易',
    deferred_posting: '可能延後入帳',
    installment_issue: '分期資料不同',
    unresolved_difference: '整體差額仍未解',
  } as Record<string, string>)[kind] ?? '需要人工確認';
}

function confidenceLabel(kind: string, confidence: number): string {
  if (confidence === 0) return '沒有可信配對';
  return kind === 'unresolved_difference' ? `差額推測 ${confidence}%` : `配對信心 ${confidence}%`;
}

function primaryDecisionLabel(patchKind: string | undefined): string {
  if (patchKind === 'acknowledge_unresolved') return '保留為未解';
  if (patchKind === 'assign_statement') return '套用這組配對';
  if (patchKind === 'create_transaction') return '加入帳本';
  return '接受修正';
}

function secondaryDecisionLabel(patchKind: string | undefined): string {
  if (patchKind === 'assign_statement') return '不要配對';
  if (patchKind === 'create_transaction') return '先不記';
  return '不採用此提案';
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value ? value : undefined;
}

function evidenceString(evidence: Record<string, unknown>, key: string): string | undefined {
  const value = evidence[key];
  return typeof value === 'string' && value ? value : undefined;
}

function installmentLabel(item: AuditDetail['items'][number] | undefined): string | null {
  return item?.installmentCurrent && item.installmentTotal ? `分期 ${item.installmentCurrent}/${item.installmentTotal}` : null;
}

function statusLabel(status: string): string {
  return ({ reviewing: '等待確認', completed: '已完成', archived: '已封存', superseded: '已被新版取代', matching: '配對中' } as Record<string, string>)[status] ?? status;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
