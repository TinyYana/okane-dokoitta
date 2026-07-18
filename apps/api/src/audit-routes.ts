import { createHash } from 'node:crypto';
import {
  buildAuditReportStats,
  scorePair,
  solveDiscrepancy,
  type DiscrepancyCandidate,
  type MatchRecord,
} from '@okane-dokoitta/audit-engine';
import { DEFAULT_EXPENSE_CATEGORIES } from '@okane-dokoitta/domain';
import {
  applyAuditPatch,
  completeAuditSession,
  createAuditImport,
  createGroupedAuditImport,
  getAuditSession,
  listAuditLedgerCandidates,
  listAuditSessions,
  listAccounts,
  listTransactions,
  markAuditImportFailed,
  newId,
  findImportFileForPurge,
  markImportFilePurgedByUser,
  resolveCreditCardsByLast4,
  saveAuditResults,
  toJsonSafe,
  type Db,
  type NewAuditCandidate,
} from '@okane-dokoitta/database';
import { detectImporters, importerById, ImporterError, type CsvColumn, type ImportInput } from '@okane-dokoitta/importers';
import { zAuditImport, zPatchDecision, zUuidV7 } from '@okane-dokoitta/schemas';
import { Hono } from 'hono';
import type { AuthContext } from './auth.js';
import type { ApiEnv } from './env.js';
import { removeStoredImport, storeEncryptedImport } from './file-store.js';
import { suggestCategoryFromHistory } from './category-suggestion.js';

type Variables = { auth: AuthContext };

export function auditRoutes(db: Db, env: ApiEnv): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/sessions', async (c) => {
    return c.json(toJsonSafe({ sessions: await listAuditSessions(db, c.get('auth').userId) }) as Record<string, unknown>);
  });

  app.get('/sessions/:id', async (c) => {
    const id = zUuidV7.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: { code: 'AUDIT_INVALID', message: '審計 ID 無效' } }, 422);
    const session = await getAuditSession(db, c.get('auth').userId, id.data);
    return session
      ? c.json(toJsonSafe(session) as Record<string, unknown>)
      : c.json({ error: { code: 'NOT_FOUND', message: '找不到審計工作階段' } }, 404);
  });

  app.post('/import', async (c) => {
    if (!env.fileKey) return c.json({ error: { code: 'FILE_KEY_REQUIRED', message: '架設者尚未設定 OKANE_DOKOITTA_FILE_KEY' } }, 503);
    const parsed = zAuditImport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'IMPORT_INVALID', message: parsed.error.issues[0]?.message ?? '匯入資料無效' } }, 422);
    const input = parsed.data;
    const importerInput = toImporterInput(input);
    const importer = input.importerId === 'auto' ? detectImporters(importerInput)[0]?.importer : importerById(input.importerId);
    if (!importer) return c.json({ error: { code: 'IMPORTER_UNAVAILABLE', message: '此 importer 尚不可用' } }, 422);
    let normalized;
    try {
      normalized = await importer.parse(importerInput);
    } catch (error) {
      if (error instanceof ImporterError) return c.json({ error: { code: error.code, message: error.message } }, 422);
      throw error;
    }
    const auth = c.get('auth');
    const fileId = newId();
    const statementId = newId();
    const sessionId = newId();
    const statement = normalized.statement;
    const totalMinor = statement.totalMinor ?? (input.defaults.total ? parseDecimalMinor(input.defaults.total, input.defaults.currency) : undefined);
    const periodStart = statement.periodStart ?? input.defaults.periodStart;
    const periodEnd = statement.periodEnd ?? input.defaults.periodEnd;
    const statementDate = statement.statementDate ?? input.defaults.statementDate;
    const dueDate = statement.dueDate ?? input.defaults.dueDate;
    if (!periodStart || !periodEnd || !statementDate || !dueDate || totalMinor === undefined) {
      return c.json({ error: { code: 'IMPORT_FIELDS_REQUIRED', message: '此格式無法自動取得帳單期間、帳單日、繳款日或總額，請補齊欄位' } }, 422);
    }
    const items = statement.transactions.map((item, index) => ({
      id: newId(),
      lineNo: index + 1,
      merchantRaw: item.merchantRaw,
      ...(item.merchantNormalized ? { merchantNormalized: item.merchantNormalized } : {}),
      amountMinor: item.amountMinor,
      currency: item.currency,
      ...(item.occurredAt ? { occurredDate: item.occurredAt.slice(0, 10) } : {}),
      ...(item.postedAt ? { postedDate: item.postedAt.slice(0, 10) } : {}),
      ...(item.cardLast4 ? { cardLast4: item.cardLast4 } : {}),
      ...(item.installment ? { installmentCurrent: item.installment.current, installmentTotal: item.installment.total } : {}),
      raw: {
        ...(toJsonSafe(item.metadata) as Record<string, unknown>),
        ...(input.sourceText ? { inputOrigin: 'ai_confirmed' } : {}),
      },
    }));
    const itemLast4s = [...new Set(items.flatMap((item) => item.cardLast4 ? [item.cardLast4] : []))];
    let cardAccountId = input.creditCardAccountId;
    if (importer.id === 'union-bank-credit-card') {
      const institution = statement.institution ?? '聯邦銀行';
      const mappedCards = await resolveCreditCardsByLast4(db, auth.userId, institution, itemLast4s);
      const duplicateLast4s = itemLast4s.filter((last4) => mappedCards.filter((card) => card.last4 === last4).length !== 1);
      if (mappedCards.length !== itemLast4s.length || duplicateLast4s.length > 0) {
        const mapped = new Set(mappedCards.map((card) => card.last4));
        const missing = itemLast4s.filter((last4) => !mapped.has(last4));
        return c.json({
          error: {
            code: 'CREDIT_CARD_MAPPING_REQUIRED',
            message: `請先建立且正確設定聯邦銀行卡片末四碼：${[...new Set([...missing, ...duplicateLast4s])].join('、')}`,
          },
        }, 422);
      }
      if (mappedCards.length === 1) cardAccountId = mappedCards[0]!.accountId;
      if (mappedCards.length > 1) {
        const bytes = Buffer.from(input.sourceText ?? input.text, 'utf8');
        const storagePath = await storeEncryptedImport(env.dataDir, auth.userId, fileId, bytes, env.fileKey, env.importBucket);
        const retainUntil = addDays(new Date(), env.importRetentionDays).toISOString().slice(0, 10);
        const groupId = newId();
        const children = mappedCards.map((card) => {
          const childItems = items.filter((item) => item.cardLast4 === card.last4);
          return {
            statement: {
              id: newId(), creditCardAccountId: card.accountId, periodStart, periodEnd, statementDate, dueDate,
              totalMinor: childItems.reduce((sum, item) => sum + item.amountMinor, 0n), currency: statement.currency,
            },
            sessionId: newId(),
            items: childItems,
          };
        });
        let persisted = false;
        try {
          await createGroupedAuditImport(db, auth.userId, {
            importFile: {
              id: fileId, filename: input.filename, mime: 'text/csv', size: bytes.byteLength,
              sha256: createHash('sha256').update(bytes).digest('hex'), storagePath, importerId: importer.id, retainUntil,
            },
            group: {
              id: groupId, institution, periodStart, periodEnd, statementDate, dueDate,
              totalMinor, currency: statement.currency,
            },
            children,
          });
          persisted = true;
          for (const child of children) {
            await runMatching(
              db, auth.userId, child.sessionId, child.statement.id, child.statement.creditCardAccountId,
              periodStart, periodEnd, child.statement.totalMinor, child.items, normalized.warnings,
            );
          }
        } catch (error) {
          if (persisted) {
            for (const child of children) await markAuditImportFailed(db, auth.userId, fileId, child.sessionId, errorCodeOf(error));
          } else await removeStoredImport(env.dataDir, storagePath, env.importBucket);
          throw error;
        }
        return c.json({
          groupId,
          sessionId: children[0]!.sessionId,
          statementId: children[0]!.statement.id,
          sessions: children.map((child) => ({ sessionId: child.sessionId, statementId: child.statement.id })),
          warnings: normalized.warnings,
        }, 201);
      }
    } else if (itemLast4s.length > 1) {
      return c.json({ error: { code: 'MULTI_CARD_STATEMENT_UNSUPPORTED', message: '這份通用帳單同時含多張卡，但無法確認每張卡的銀行帳單邊界' } }, 422);
    }
    const bytes = Buffer.from(input.sourceText ?? input.text, 'utf8');
    const storagePath = await storeEncryptedImport(env.dataDir, auth.userId, fileId, bytes, env.fileKey, env.importBucket);
    const retainUntil = addDays(new Date(), env.importRetentionDays).toISOString().slice(0, 10);
    let persisted = false;
    try {
      await createAuditImport(db, auth.userId, {
        importFile: {
          id: fileId,
          filename: input.filename,
          mime: input.filename.toLowerCase().endsWith('.csv') ? 'text/csv' : 'text/plain',
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          storagePath,
          importerId: importer.id,
          retainUntil,
        },
        statement: {
          id: statementId,
          creditCardAccountId: cardAccountId,
          periodStart,
          periodEnd,
          statementDate,
          dueDate,
          totalMinor,
          currency: statement.currency,
        },
        sessionId,
        items,
      });
      persisted = true;
      await runMatching(db, auth.userId, sessionId, statementId, cardAccountId, periodStart, periodEnd, totalMinor, items, normalized.warnings);
    } catch (error) {
      if (persisted) await markAuditImportFailed(db, auth.userId, fileId, sessionId, errorCodeOf(error));
      else await removeStoredImport(env.dataDir, storagePath, env.importBucket);
      throw error;
    }
    return c.json({ sessionId, statementId, warnings: normalized.warnings }, 201);
  });

  app.post('/patches/:id/decision', async (c) => {
    const id = zUuidV7.safeParse(c.req.param('id'));
    const body = zPatchDecision.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: { code: 'DECISION_INVALID', message: '決定格式無效' } }, 422);
    const auth = c.get('auth');
    const result = await applyAuditPatch(
      db,
      { id: auth.userId, ledgerTimeZone: auth.ledgerTimeZone },
      id.data,
      body.data.accept,
      body.data.categoryAccountId ? { categoryAccountId: body.data.categoryAccountId } : {},
    );
    return result ? c.json(result) : c.json({ error: { code: 'NOT_FOUND', message: '找不到可處理的修正提案' } }, 404);
  });

  app.post('/sessions/:id/complete', async (c) => {
    const id = zUuidV7.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: { code: 'AUDIT_INVALID', message: '審計 ID 無效' } }, 422);
    const ok = await completeAuditSession(db, c.get('auth').userId, id.data);
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'AUDIT_NOT_READY', message: '仍有待處理項目，尚不能完成審計' } }, 409);
  });

  app.post('/files/:id/purge', async (c) => {
    const id = zUuidV7.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: { code: 'FILE_INVALID', message: '檔案 ID 無效' } }, 422);
    const file = await findImportFileForPurge(db, c.get('auth').userId, id.data);
    if (!file) return c.json({ error: { code: 'NOT_FOUND', message: '找不到匯入檔' } }, 404);
    await removeStoredImport(env.dataDir, file.storagePath, env.importBucket);
    await markImportFilePurgedByUser(db, c.get('auth').userId, id.data);
    return c.json({ ok: true });
  });

  return app;
}

async function runMatching(
  db: Db,
  userId: string,
  sessionId: string,
  statementId: string,
  cardAccountId: string,
  periodStart: string,
  periodEnd: string,
  statementTotalMinor: bigint,
  items: Array<{ id: string; amountMinor: bigint; currency: string; occurredDate?: string; postedDate?: string; merchantRaw: string; merchantNormalized?: string; cardLast4?: string; installmentCurrent?: number; installmentTotal?: number }>,
  warnings: unknown[],
) {
  const from = new Date(`${periodStart}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 45);
  const to = new Date(`${periodEnd}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + 10);
  const [ledger, accountRows, history] = await Promise.all([
    listAuditLedgerCandidates(db, userId, cardAccountId, from, to),
    listAccounts(db, userId),
    listTransactions(db, userId, { limit: 200 }),
  ]);
  const activeCategories = accountRows.filter((account) => !account.archivedAt && (account.subtype === 'category_expense' || account.subtype === 'category_income'));
  const unused = new Set(ledger.map((transaction) => transaction.id));
  const candidates: NewAuditCandidate[] = [];
  let ledgerExpectedMinor = 0n;

  for (const item of items) {
    const statementRecord: MatchRecord = {
      id: item.id,
      amountMinor: item.amountMinor,
      currency: item.currency,
      ...(item.occurredDate ? { occurredDate: item.occurredDate } : {}),
      ...(item.postedDate ? { postedDate: item.postedDate } : {}),
      merchantRaw: item.merchantRaw,
      ...(item.merchantNormalized ? { merchantNormalized: item.merchantNormalized } : {}),
      ...(item.cardLast4 ? { cardLast4: item.cardLast4 } : {}),
      ...(item.installmentCurrent && item.installmentTotal ? { installment: { current: item.installmentCurrent, total: item.installmentTotal } } : {}),
      ...(item.amountMinor < 0n ? { type: item.merchantRaw.includes('回饋') ? 'income' : 'refund' } : {}),
    };
    const ranked = ledger
        .filter((transaction) => unused.has(transaction.id))
        .filter((transaction) => !item.merchantRaw.includes('回饋') || transaction.type === 'income')
        .map((transaction) => ({ transaction, score: scorePair(statementRecord, transactionRecord(transaction)) }))
        .sort((left, right) => right.score.score - left.score.score);
    const best = ranked[0];
    if (best && best.score.score >= 0.6 && best.transaction.amountMinor === abs(item.amountMinor)) {
      unused.delete(best.transaction.id);
      ledgerExpectedMinor += signedLedgerAmount(best.transaction);
      const candidateId = newId();
      candidates.push({
        id: candidateId,
        statementItemId: item.id,
        transactionId: best.transaction.id,
        kind: 'match',
        score: best.score.score.toFixed(4),
        reasoningCodes: best.score.reasoningCodes,
        evidence: best.score.evidence,
        explanation: best.score.explanation,
        patch: {
          id: newId(),
          kind: 'assign_statement',
          payload: { transactionId: best.transaction.id, statementId, statementItemId: item.id },
        },
      });
    } else if (best && best.score.score >= 0.6) {
      const candidateId = newId();
      candidates.push({
        id: candidateId, statementItemId: item.id, transactionId: best.transaction.id,
        kind: 'amount_mismatch', score: best.score.score.toFixed(4), reasoningCodes: best.score.reasoningCodes,
        evidence: best.score.evidence, explanation: best.score.explanation,
        patch: unresolvedPatch(candidateId, 'amount_mismatch', best.score.evidence),
      });
    } else {
      const candidateId = newId();
      const transactionType = item.amountMinor > 0n
        ? (item.merchantRaw.includes('手續費') ? 'fee' : 'expense')
        : item.merchantRaw.includes('回饋') ? 'income' : null;
      const categorySubtype = transactionType === 'income' ? 'category_income' : 'category_expense';
      const categoryName = transactionType === 'income'
        ? '信用卡回饋'
        : transactionType === 'fee' ? '海外交易手續費' : DEFAULT_EXPENSE_CATEGORIES.at(-1)!;
      const suggested = transactionType === 'expense' ? suggestCategoryFromHistory(history, item.merchantRaw, 'expense') : null;
      const category = suggested
        ? activeCategories.find((account) => account.id === suggested.categoryAccountId && account.subtype === categorySubtype)
        : activeCategories.find((account) => account.name === categoryName && account.subtype === categorySubtype);
      candidates.push({
        id: candidateId, statementItemId: item.id, kind: 'missing_in_ledger', score: '0.0000', reasoningCodes: [],
        evidence: { amountMinor: item.amountMinor.toString(), merchantRaw: item.merchantRaw },
        explanation: transactionType
          ? '帳單有這筆，但帳本沒有；已準備成待確認的記帳草稿'
          : '這筆可能是退款或調整，需要先連結原始交易，暫時保留為未解',
        patch: transactionType ? {
          id: newId(),
          kind: 'create_transaction',
          payload: {
            transactionId: newId(), mutationId: newId(), statementId, statementItemId: item.id,
            transactionType, categoryAccountId: category?.id ?? null,
            categorySource: suggested && category ? 'history' : category && transactionType !== 'expense' ? 'special' : category ? 'fallback' : 'missing',
            needsReview: transactionType === 'expense' && !(suggested && category),
          },
        } : unresolvedPatch(candidateId, 'missing_in_ledger', { statementItemId: item.id }),
      });
    }
  }
  for (const transaction of ledger.filter((row) => unused.has(row.id))) {
    const candidateId = newId();
    candidates.push({
      id: candidateId, transactionId: transaction.id, kind: 'missing_in_statement', score: '0.0000', reasoningCodes: [],
      evidence: { amountMinor: transaction.amountMinor.toString(), merchantRaw: transaction.merchantRaw ?? '' },
      explanation: '帳本有這筆，但帳單期間內沒有配對項目',
      patch: unresolvedPatch(candidateId, 'missing_in_statement', { transactionId: transaction.id }),
    });
  }

  const report = buildAuditReportStats({
    statementTotalMinor,
    ledgerExpectedMinor,
    candidates: candidates.filter((candidate) => candidate.kind !== 'unresolved_difference').map((candidate) => ({ kind: candidate.kind as Parameters<typeof buildAuditReportStats>[0]['candidates'][number]['kind'], score: Number(candidate.score) })),
  });
  const discrepancyInputs: DiscrepancyCandidate[] = [
    ...items.filter((item) => candidates.some((candidate) => candidate.statementItemId === item.id && candidate.kind === 'missing_in_ledger')).map((item) => ({ id: item.id, amountMinor: item.amountMinor, role: 'statement_unmatched' as const })),
    ...ledger.filter((row) => unused.has(row.id)).map((row) => ({ id: row.id, amountMinor: signedLedgerAmount(row), role: 'ledger_unmatched' as const })),
  ];
  const discrepancy = solveDiscrepancy(report.differenceMinor, discrepancyInputs.slice(0, 300));
  if (report.differenceMinor !== 0n && discrepancyInputs.length === 0) {
    const candidateId = newId();
    candidates.push({
      id: candidateId, kind: 'unresolved_difference', score: discrepancy.hypotheses[0]?.confidence.toFixed(4) ?? '0.0000', reasoningCodes: [],
      evidence: toJsonSafe(discrepancy) as Record<string, unknown>,
      explanation: discrepancy.hypotheses[0]?.explanation ?? '差額尚未能自動解釋，請保留為明確未解項目',
      patch: unresolvedPatch(candidateId, 'unresolved_difference', { differenceMinor: report.differenceMinor.toString() }),
    });
  }
  await saveAuditResults(db, userId, sessionId, candidates, toJsonSafe({
    ...report,
    statementItemsSumMinor: items.reduce((sum, item) => sum + item.amountMinor, 0n),
    importerWarnings: warnings,
    discrepancy,
  }) as Record<string, unknown>);
}

function unresolvedPatch(candidateId: string, reason: string, evidence: Record<string, unknown>) {
  return {
    id: newId(),
    kind: 'acknowledge_unresolved' as const,
    payload: { candidateId, reason, evidence },
  };
}

function transactionRecord(transaction: Awaited<ReturnType<typeof listAuditLedgerCandidates>>[number]): MatchRecord {
  return {
    id: transaction.id,
    amountMinor: signedLedgerAmount(transaction),
    currency: transaction.currency,
    occurredDate: transaction.occurredAt.toISOString().slice(0, 10),
    ...(transaction.postedAt ? { postedDate: transaction.postedAt.toISOString().slice(0, 10) } : {}),
    ...(transaction.merchantRaw ? { merchantRaw: transaction.merchantRaw } : {}),
    ...(transaction.merchantNormalized ? { merchantNormalized: transaction.merchantNormalized } : {}),
    ...(transaction.installmentCurrent && transaction.installmentTotal ? { installment: { current: transaction.installmentCurrent, total: transaction.installmentTotal } } : {}),
    type: transaction.type,
  };
}

function signedLedgerAmount(transaction: Awaited<ReturnType<typeof listAuditLedgerCandidates>>[number]): bigint {
  return transaction.type === 'refund' || transaction.type === 'income' ? -abs(transaction.amountMinor) : abs(transaction.amountMinor);
}

function toImporterInput(input: ReturnType<typeof zAuditImport.parse>): ImportInput {
  const defaults = {
    currency: input.defaults.currency,
    ...(input.defaults.institution ? { institution: input.defaults.institution } : {}),
    ...(input.defaults.cardLast4 ? { cardLast4: input.defaults.cardLast4 } : {}),
    ...(input.defaults.periodStart ? { periodStart: input.defaults.periodStart } : {}),
    ...(input.defaults.periodEnd ? { periodEnd: input.defaults.periodEnd } : {}),
    ...(input.defaults.statementDate ? { statementDate: input.defaults.statementDate } : {}),
    ...(input.defaults.dueDate ? { dueDate: input.defaults.dueDate } : {}),
    ...(input.defaults.total ? { total: input.defaults.total } : {}),
  };
  if (input.kind === 'csv') return {
    kind: 'csv', text: input.text, filename: input.filename,
    ...(input.delimiter ? { delimiter: input.delimiter } : {}),
    ...(input.columns ? { columns: input.columns as Partial<Record<CsvColumn, string>> } : {}),
    defaults,
  };
  if (input.kind === 'pdf') return { kind: 'pdf', extractedText: input.text, filename: input.filename, defaults };
  return { kind: 'text', text: input.text, defaults };
}

function parseDecimalMinor(value: string, currency: string): bigint {
  const exponent = currency === 'USD' ? 2 : 0;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('invalid total');
  const fraction = (match[3] ?? '').padEnd(exponent, '0');
  if (fraction.length > exponent) throw new Error('total exceeds currency precision');
  const minor = BigInt(match[2]!) * (10n ** BigInt(exponent)) + BigInt(fraction || '0');
  return match[1] ? -minor : minor;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function errorCodeOf(error: unknown): string {
  return error instanceof Error ? error.name.toUpperCase().slice(0, 80) : 'UNKNOWN_ERROR';
}
