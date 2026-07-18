import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { DomainError, instantFromCivilDate, parseCivilDate, validateAssignStatementPatch } from '@okane-dokoitta/domain';
import type { Db } from './client.js';
import { newId } from './ids.js';
import {
  auditCandidates,
  auditLogs,
  auditSessions,
  accounts,
  creditCards,
  importFiles,
  proposedPatches,
  statementItems,
  statementGroups,
  statements,
  transactions,
} from './schema.js';
import { recordChange } from './sync.js';
import { applyMutation, type MutationUser } from './mutations.js';

export interface NewAuditItem {
  id: string;
  lineNo: number;
  merchantRaw: string;
  merchantNormalized?: string;
  amountMinor: bigint;
  currency: string;
  occurredDate?: string;
  postedDate?: string;
  cardLast4?: string;
  installmentCurrent?: number;
  installmentTotal?: number;
  raw: Record<string, unknown>;
}

export interface NewAuditImport {
  importFile: {
    id: string;
    filename: string;
    mime: string;
    size: number;
    sha256: string;
    storagePath: string;
    importerId: string;
    retainUntil: string;
  };
  statement: {
    id: string;
    creditCardAccountId: string;
    periodStart: string;
    periodEnd: string;
    statementDate: string;
    dueDate: string;
    totalMinor: bigint;
    currency: string;
  };
  sessionId: string;
  items: NewAuditItem[];
}

export interface NewGroupedAuditImport {
  importFile: NewAuditImport['importFile'];
  group: {
    id: string;
    institution: string;
    periodStart: string;
    periodEnd: string;
    statementDate: string;
    dueDate: string;
    totalMinor: bigint;
    currency: string;
  };
  children: Array<{ statement: NewAuditImport['statement']; sessionId: string; items: NewAuditItem[] }>;
}

export async function resolveCreditCardsByLast4(
  db: Db,
  userId: string,
  issuer: string,
  last4s: string[],
): Promise<Array<{ accountId: string; last4: string }>> {
  if (last4s.length === 0) return [];
  const rows = await db
    .select({ accountId: accounts.id, last4: creditCards.last4 })
    .from(accounts)
    .innerJoin(creditCards, eq(creditCards.accountId, accounts.id))
    .where(and(
      eq(accounts.userId, userId),
      isNull(accounts.deletedAt),
      eq(creditCards.issuer, issuer),
      inArray(creditCards.last4, last4s),
    ));
  return rows.flatMap((row) => row.last4 ? [{ accountId: row.accountId, last4: row.last4 }] : []);
}

export async function createAuditImport(db: Db, userId: string, input: NewAuditImport): Promise<void> {
  await db.transaction(async (tx) => {
    const [card] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, input.statement.creditCardAccountId), eq(accounts.userId, userId), eq(accounts.subtype, 'credit_card'), isNull(accounts.deletedAt)))
      .limit(1);
    if (!card) throw new Error('credit card unavailable');

    const previous = await tx
      .select({ id: statements.id, auditSessionId: statements.auditSessionId, status: statements.status })
      .from(statements)
      .where(and(
        eq(statements.userId, userId),
        eq(statements.creditCardAccountId, input.statement.creditCardAccountId),
        eq(statements.statementDate, input.statement.statementDate),
      ));
    if (previous.length > 0) {
      await tx.update(statements).set({ status: 'superseded', updatedAt: new Date() }).where(inArray(statements.id, previous.map((row) => row.id)));
      const sessionIds = previous.flatMap((row) => row.auditSessionId ? [row.auditSessionId] : []);
      if (sessionIds.length > 0) await tx.update(auditSessions).set({ status: 'superseded' }).where(inArray(auditSessions.id, sessionIds));
      await tx.insert(auditLogs).values([
        ...previous.map((row) => ({
          id: newId(), userId, actor: 'system' as const, entity: 'statements', entityId: row.id,
          action: 'supersede', before: { status: row.status }, after: { status: 'superseded' },
        })),
        ...sessionIds.map((id) => ({
          id: newId(), userId, actor: 'system' as const, entity: 'audit_sessions', entityId: id,
          action: 'supersede', after: { status: 'superseded' },
        })),
      ]);
    }

    await tx.insert(importFiles).values({ ...input.importFile, userId, status: 'parsed' });
    await tx.insert(statements).values({
      ...input.statement,
      userId,
      importFileId: input.importFile.id,
      auditSessionId: input.sessionId,
      status: 'closed',
    });
    await tx.insert(auditSessions).values({
      id: input.sessionId,
      userId,
      statementId: input.statement.id,
      status: 'matching',
      stats: {},
    });
    if (input.items.length > 0) {
      await tx.insert(statementItems).values(input.items.map((item) => ({ ...item, statementId: input.statement.id })));
    }
    await tx.insert(auditLogs).values([
      {
        id: newId(), userId, actor: 'user', entity: 'import_files', entityId: input.importFile.id,
        action: 'create', after: { filename: input.importFile.filename, importerId: input.importFile.importerId, size: input.importFile.size },
      },
      {
        id: newId(), userId, actor: 'system', entity: 'statements', entityId: input.statement.id,
        action: 'create', after: { importFileId: input.importFile.id, auditSessionId: input.sessionId, itemCount: input.items.length },
      },
      ...input.items.map((item) => ({
        id: newId(), userId, actor: 'system' as const, entity: 'statement_items', entityId: item.id,
        action: 'create', after: { statementId: input.statement.id, lineNo: item.lineNo },
      })),
      {
        id: newId(), userId, actor: 'system', entity: 'audit_sessions', entityId: input.sessionId,
        action: 'create', after: { statementId: input.statement.id, itemCount: input.items.length },
      },
    ]);
  });
}

/** 一個銀行合併帳單檔，原始檔只存一次；每張卡各建 statement/session 做獨立審計。 */
export async function createGroupedAuditImport(db: Db, userId: string, input: NewGroupedAuditImport): Promise<void> {
  if (input.children.length < 2) throw new Error('grouped audit import needs at least two cards');
  await db.transaction(async (tx) => {
    const cardIds = input.children.map((child) => child.statement.creditCardAccountId);
    if (new Set(cardIds).size !== cardIds.length) throw new Error('duplicate card in statement group');
    const cards = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.subtype, 'credit_card'), isNull(accounts.deletedAt), inArray(accounts.id, cardIds)));
    if (cards.length !== cardIds.length) throw new Error('credit card unavailable');

    const previous = await tx
      .select({ id: statements.id, auditSessionId: statements.auditSessionId, status: statements.status })
      .from(statements)
      .where(and(
        eq(statements.userId, userId),
        eq(statements.statementDate, input.group.statementDate),
        inArray(statements.creditCardAccountId, cardIds),
      ));
    if (previous.length > 0) {
      await tx.update(statements).set({ status: 'superseded', updatedAt: new Date() }).where(inArray(statements.id, previous.map((row) => row.id)));
      const previousSessionIds = previous.flatMap((row) => row.auditSessionId ? [row.auditSessionId] : []);
      if (previousSessionIds.length > 0) await tx.update(auditSessions).set({ status: 'superseded' }).where(inArray(auditSessions.id, previousSessionIds));
      await tx.insert(auditLogs).values([
        ...previous.map((row) => ({
          id: newId(), userId, actor: 'system' as const, entity: 'statements', entityId: row.id,
          action: 'supersede', before: { status: row.status }, after: { status: 'superseded' },
        })),
        ...previousSessionIds.map((id) => ({
          id: newId(), userId, actor: 'system' as const, entity: 'audit_sessions', entityId: id,
          action: 'supersede', after: { status: 'superseded' },
        })),
      ]);
    }

    await tx.insert(importFiles).values({ ...input.importFile, userId, status: 'parsed' });
    await tx.insert(statementGroups).values({ ...input.group, userId, importFileId: input.importFile.id });
    for (const child of input.children) {
      await tx.insert(statements).values({
        ...child.statement,
        userId,
        importFileId: input.importFile.id,
        groupId: input.group.id,
        auditSessionId: child.sessionId,
        status: 'closed',
      });
      await tx.insert(auditSessions).values({
        id: child.sessionId,
        userId,
        statementId: child.statement.id,
        status: 'matching',
        stats: {},
      });
      if (child.items.length > 0) {
        await tx.insert(statementItems).values(child.items.map((item) => ({ ...item, statementId: child.statement.id })));
      }
    }
    await tx.insert(auditLogs).values([
      {
        id: newId(), userId, actor: 'user', entity: 'import_files', entityId: input.importFile.id,
        action: 'create', after: { filename: input.importFile.filename, importerId: input.importFile.importerId, size: input.importFile.size },
      },
      {
        id: newId(), userId, actor: 'system', entity: 'statement_groups', entityId: input.group.id,
        action: 'create', after: { importFileId: input.importFile.id, cardCount: input.children.length, totalMinor: input.group.totalMinor.toString() },
      },
      ...input.children.flatMap((child) => [
        {
          id: newId(), userId, actor: 'system' as const, entity: 'statements', entityId: child.statement.id,
          action: 'create', after: { groupId: input.group.id, importFileId: input.importFile.id, auditSessionId: child.sessionId, itemCount: child.items.length },
        },
        ...child.items.map((item) => ({
          id: newId(), userId, actor: 'system' as const, entity: 'statement_items', entityId: item.id,
          action: 'create', after: { statementId: child.statement.id, lineNo: item.lineNo },
        })),
        {
          id: newId(), userId, actor: 'system' as const, entity: 'audit_sessions', entityId: child.sessionId,
          action: 'create', after: { statementId: child.statement.id, itemCount: child.items.length },
        },
      ]),
    ]);
  });
}

export async function listAuditLedgerCandidates(
  db: Db,
  userId: string,
  cardAccountId: string,
  from: Date,
  to: Date,
) {
  return db
    .select()
    .from(transactions)
    .where(and(
      eq(transactions.userId, userId),
      isNull(transactions.deletedAt),
      or(eq(transactions.fromAccountId, cardAccountId), eq(transactions.toAccountId, cardAccountId)),
      gte(transactions.occurredAt, from),
      lte(transactions.occurredAt, to),
    ))
    .orderBy(asc(transactions.occurredAt))
    .limit(500);
}

export interface NewAuditCandidate {
  id: string;
  statementItemId?: string;
  transactionId?: string;
  kind: typeof auditCandidates.$inferInsert.kind;
  score: string;
  reasoningCodes: string[];
  evidence: Record<string, unknown>;
  explanation: string;
  patch: { id: string; kind: typeof proposedPatches.$inferInsert.kind; payload: Record<string, unknown> };
}

export async function saveAuditResults(
  db: Db,
  userId: string,
  sessionId: string,
  candidates: NewAuditCandidate[],
  stats: Record<string, unknown>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: auditSessions.id })
      .from(auditSessions)
      .where(and(eq(auditSessions.id, sessionId), eq(auditSessions.userId, userId)))
      .limit(1);
    if (!session) throw new Error('audit session unavailable');
    if (candidates.length > 0) {
      await tx.insert(auditCandidates).values(candidates.map(({ patch: _patch, ...candidate }) => ({ ...candidate, sessionId })));
      const patches = candidates.map((candidate) => ({
        ...candidate.patch,
        userId,
        sessionId,
        candidateId: candidate.id,
        origin: 'rule' as const,
        status: 'proposed' as const,
      }));
      await tx.insert(proposedPatches).values(patches);
      await tx.insert(auditLogs).values([
        ...candidates.map((candidate) => ({
          id: newId(), userId, actor: 'system' as const, entity: 'audit_candidates', entityId: candidate.id,
          action: 'create', after: { sessionId, kind: candidate.kind, patchId: candidate.patch.id },
        })),
        ...patches.map((patch) => ({
          id: newId(), userId, actor: 'system' as const, entity: 'proposed_patches', entityId: patch.id,
          action: 'create', after: { sessionId, candidateId: patch.candidateId, kind: patch.kind, status: 'proposed' },
        })),
      ]);
    }
    await tx.update(auditSessions).set({ status: 'reviewing', stats }).where(eq(auditSessions.id, sessionId));
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'system', entity: 'audit_sessions', entityId: sessionId,
      action: 'matching_complete', before: { status: 'matching' }, after: { status: 'reviewing', stats },
    });
  });
}

export async function listAuditSessions(db: Db, userId: string) {
  return db
    .select({ session: auditSessions, statement: statements, group: statementGroups })
    .from(auditSessions)
    .innerJoin(statements, eq(statements.id, auditSessions.statementId))
    .leftJoin(statementGroups, eq(statementGroups.id, statements.groupId))
    .where(eq(auditSessions.userId, userId))
    .orderBy(desc(auditSessions.createdAt));
}

export async function getAuditSession(db: Db, userId: string, sessionId: string) {
  const [header] = await db
    .select({ session: auditSessions, statement: statements, group: statementGroups, file: importFiles })
    .from(auditSessions)
    .innerJoin(statements, eq(statements.id, auditSessions.statementId))
    .leftJoin(statementGroups, eq(statementGroups.id, statements.groupId))
    .leftJoin(importFiles, eq(importFiles.id, statements.importFileId))
    .where(and(eq(auditSessions.id, sessionId), eq(auditSessions.userId, userId)))
    .limit(1);
  if (!header) return null;
  const [items, candidates, patches] = await Promise.all([
    db.select().from(statementItems).where(eq(statementItems.statementId, header.statement.id)).orderBy(asc(statementItems.lineNo)),
    db.select().from(auditCandidates).where(eq(auditCandidates.sessionId, sessionId)).orderBy(desc(auditCandidates.score)),
    db.select().from(proposedPatches).where(and(eq(proposedPatches.sessionId, sessionId), eq(proposedPatches.userId, userId))),
  ]);
  const matchedTotal = items.reduce((sum, item) => sum + (item.matchedTransactionId ? item.amountMinor : 0n), 0n);
  return {
    ...header,
    session: {
      ...header.session,
      stats: {
        ...(header.session.stats as Record<string, unknown>),
        ledgerExpectedMinor: matchedTotal.toString(),
        differenceMinor: (header.statement.totalMinor - matchedTotal).toString(),
        correctedBalanced: header.statement.totalMinor === matchedTotal,
      },
    },
    items,
    candidates,
    patches,
  };
}

export async function applyAuditPatch(
  db: Db,
  user: MutationUser,
  patchId: string,
  accept: boolean,
  decision: { categoryAccountId?: string } = {},
) {
  const userId = user.id;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ patch: proposedPatches, session: auditSessions })
      .from(proposedPatches)
      .innerJoin(auditSessions, eq(auditSessions.id, proposedPatches.sessionId))
      .where(and(eq(proposedPatches.id, patchId), eq(proposedPatches.userId, userId), eq(auditSessions.userId, userId)))
      .limit(1)
      .for('update');
    if (!row) return null;
    if (!accept) {
      if (row.patch.status !== 'proposed' && row.patch.status !== 'failed') return null;
      if (row.patch.candidateId) {
        const decided = await tx
          .update(auditCandidates)
          .set({ decision: 'rejected' })
          .where(and(eq(auditCandidates.id, row.patch.candidateId), eq(auditCandidates.decision, 'pending')))
          .returning({ id: auditCandidates.id });
        if (decided.length === 0) return null;
      }
      if (row.patch.status === 'proposed') await tx.update(proposedPatches).set({ status: 'rejected' }).where(eq(proposedPatches.id, patchId));
      await tx.insert(auditLogs).values({
        id: newId(), userId, actor: 'user', entity: 'proposed_patches', entityId: patchId,
        action: row.patch.status === 'failed' ? 'dismiss_failed' : 'reject',
        before: { status: row.patch.status },
        after: { status: row.patch.status === 'failed' ? 'failed' : 'rejected' },
      });
      if (row.patch.candidateId) await tx.insert(auditLogs).values({
        id: newId(), userId, actor: 'user', entity: 'audit_candidates', entityId: row.patch.candidateId,
        action: 'decide', after: { decision: 'rejected', patchId },
      });
      return { status: row.patch.status === 'failed' ? 'failed_dismissed' as const : 'rejected' as const };
    }
    if (row.patch.status !== 'proposed') return null;
    if (row.patch.kind === 'acknowledge_unresolved') {
      const auditLogId = newId();
      await tx.insert(auditLogs).values({
        id: auditLogId, userId, actor: 'user', entity: 'proposed_patches', entityId: patchId,
        action: 'acknowledge_unresolved', before: { status: 'proposed' }, after: { status: 'applied' },
      });
      await tx.update(proposedPatches).set({ status: 'applied', appliedAt: new Date(), appliedAuditLogId: auditLogId }).where(eq(proposedPatches.id, patchId));
      if (row.patch.candidateId) {
        await tx.update(auditCandidates).set({ decision: 'accepted' }).where(eq(auditCandidates.id, row.patch.candidateId));
        await tx.insert(auditLogs).values({
          id: newId(), userId, actor: 'user', entity: 'audit_candidates', entityId: row.patch.candidateId,
          action: 'decide', after: { decision: 'accepted', patchId },
        });
      }
      return { status: 'applied' as const };
    }
    let payload = row.patch.payload as { transactionId?: unknown; statementId?: unknown; statementItemId?: unknown };
    if (row.patch.kind === 'create_transaction') {
      const createPayload = row.patch.payload as {
        transactionId?: unknown; mutationId?: unknown; statementId?: unknown; statementItemId?: unknown;
        transactionType?: unknown; categoryAccountId?: unknown; needsReview?: unknown;
      };
      const categoryAccountId = decision.categoryAccountId ?? createPayload.categoryAccountId;
      if (
        typeof createPayload.transactionId !== 'string'
        || typeof createPayload.mutationId !== 'string'
        || typeof createPayload.statementId !== 'string'
        || typeof createPayload.statementItemId !== 'string'
        || !['expense', 'fee', 'income'].includes(String(createPayload.transactionType))
        || typeof categoryAccountId !== 'string'
      ) {
        await tx.update(proposedPatches).set({ status: 'failed', failureCode: 'PATCH_PAYLOAD_INVALID' }).where(eq(proposedPatches.id, patchId));
        await tx.insert(auditLogs).values({ id: newId(), userId, actor: 'system', entity: 'proposed_patches', entityId: patchId, action: 'fail', after: { status: 'failed', failureCode: 'PATCH_PAYLOAD_INVALID' } });
        return { status: 'failed' as const, code: 'PATCH_PAYLOAD_INVALID' };
      }
      const [statement] = await tx.select().from(statements).where(and(eq(statements.id, createPayload.statementId), eq(statements.userId, userId))).limit(1);
      const [item] = await tx.select().from(statementItems).where(and(eq(statementItems.id, createPayload.statementItemId), eq(statementItems.statementId, createPayload.statementId))).limit(1);
      if (!statement || !item || item.matchedTransactionId) {
        await tx.update(proposedPatches).set({ status: 'failed', failureCode: 'PATCH_TARGET_UNAVAILABLE' }).where(eq(proposedPatches.id, patchId));
        await tx.insert(auditLogs).values({ id: newId(), userId, actor: 'system', entity: 'proposed_patches', entityId: patchId, action: 'fail', after: { status: 'failed', failureCode: 'PATCH_TARGET_UNAVAILABLE' } });
        return { status: 'failed' as const, code: 'PATCH_TARGET_UNAVAILABLE' };
      }
      const transactionType = createPayload.transactionType as 'expense' | 'fee' | 'income';
      const occurredDate = item.occurredDate ?? item.postedDate ?? statement.statementDate;
      const outcome = await applyMutation(tx as unknown as Db, user, {
        mutationId: createPayload.mutationId,
        deviceId: 'audit-patch',
        entity: 'transactions',
        entityId: createPayload.transactionId,
        op: 'create',
        baseVersion: null,
        clientAt: new Date().toISOString(),
        payload: {
          type: transactionType,
          status: 'posted',
          amountMinor: item.amountMinor < 0n ? -item.amountMinor : item.amountMinor,
          currency: item.currency,
          fromAccountId: transactionType === 'income' ? null : statement.creditCardAccountId,
          toAccountId: transactionType === 'income' ? statement.creditCardAccountId : null,
          categoryAccountId,
          merchantRaw: item.merchantRaw,
          occurredAt: instantFromCivilDate(parseCivilDate(occurredDate), user.ledgerTimeZone),
          postedAt: item.postedDate ? instantFromCivilDate(parseCivilDate(item.postedDate), user.ledgerTimeZone) : null,
          dueDate: statement.dueDate,
          installmentCurrent: item.installmentCurrent,
          installmentTotal: item.installmentTotal,
          source: 'patch',
          needsReview: decision.categoryAccountId ? false : Boolean(createPayload.needsReview),
        },
      });
      if (outcome.result !== 'applied' && outcome.result !== 'duplicate') {
        const code = outcome.error?.code ?? 'PATCH_APPLY_FAILED';
        await tx.update(proposedPatches).set({ status: 'failed', failureCode: code }).where(eq(proposedPatches.id, patchId));
        await tx.insert(auditLogs).values({ id: newId(), userId, actor: 'system', entity: 'proposed_patches', entityId: patchId, action: 'fail', after: { status: 'failed', failureCode: code } });
        return { status: 'failed' as const, code };
      }
      payload = {
        transactionId: createPayload.transactionId,
        statementId: createPayload.statementId,
        statementItemId: createPayload.statementItemId,
      };
    } else if (row.patch.kind !== 'assign_statement') {
      await tx.update(proposedPatches).set({ status: 'failed', failureCode: 'PATCH_KIND_NOT_IMPLEMENTED' }).where(eq(proposedPatches.id, patchId));
      await tx.insert(auditLogs).values({ id: newId(), userId, actor: 'system', entity: 'proposed_patches', entityId: patchId, action: 'fail', after: { status: 'failed', failureCode: 'PATCH_KIND_NOT_IMPLEMENTED' } });
      return { status: 'failed' as const, code: 'PATCH_KIND_NOT_IMPLEMENTED' };
    }
    if (typeof payload.transactionId !== 'string' || typeof payload.statementId !== 'string' || typeof payload.statementItemId !== 'string') {
      await tx.update(proposedPatches).set({ status: 'failed', failureCode: 'PATCH_PAYLOAD_INVALID' }).where(eq(proposedPatches.id, patchId));
      await tx.insert(auditLogs).values({ id: newId(), userId, actor: 'system', entity: 'proposed_patches', entityId: patchId, action: 'fail', after: { status: 'failed', failureCode: 'PATCH_PAYLOAD_INVALID' } });
      return { status: 'failed' as const, code: 'PATCH_PAYLOAD_INVALID' };
    }
    const [transaction] = await tx.select().from(transactions).where(and(eq(transactions.id, payload.transactionId), eq(transactions.userId, userId), isNull(transactions.deletedAt))).limit(1);
    const [statement] = await tx.select().from(statements).where(and(eq(statements.id, payload.statementId), eq(statements.userId, userId))).limit(1);
    const [item] = await tx.select().from(statementItems).where(and(eq(statementItems.id, payload.statementItemId), eq(statementItems.statementId, payload.statementId))).limit(1);
    if (!transaction || !statement || !item) {
      await tx.update(proposedPatches).set({ status: 'failed', failureCode: 'PATCH_TARGET_UNAVAILABLE' }).where(eq(proposedPatches.id, patchId));
      await tx.insert(auditLogs).values({ id: newId(), userId, actor: 'system', entity: 'proposed_patches', entityId: patchId, action: 'fail', after: { status: 'failed', failureCode: 'PATCH_TARGET_UNAVAILABLE' } });
      return { status: 'failed' as const, code: 'PATCH_TARGET_UNAVAILABLE' };
    }
    try {
      validateAssignStatementPatch({
        transaction: { statementId: transaction.statementId, currency: transaction.currency, deleted: transaction.deletedAt !== null },
        statement: { id: statement.id, currency: statement.currency, status: statement.status },
        item: { matchedTransactionId: item.matchedTransactionId, currency: item.currency },
        transactionId: transaction.id,
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await tx.update(proposedPatches).set({ status: 'failed', failureCode: error.code }).where(eq(proposedPatches.id, patchId));
      await tx.insert(auditLogs).values({
        id: newId(), userId, actor: 'system', entity: 'proposed_patches', entityId: patchId,
        action: 'fail', after: { status: 'failed', failureCode: error.code },
      });
      return { status: 'failed' as const, code: error.code };
    }
    const auditLogId = newId();
    const version = transaction.version + 1;
    const updated = await tx
      .update(transactions)
      .set({ statementId: statement.id, statementDate: statement.statementDate, dueDate: statement.dueDate, version, updatedAt: new Date() })
      .where(and(eq(transactions.id, transaction.id), eq(transactions.version, transaction.version)))
      .returning({ id: transactions.id });
    if (updated.length === 0) {
      await tx.update(proposedPatches).set({ status: 'failed', failureCode: 'VERSION_CONFLICT' }).where(eq(proposedPatches.id, patchId));
      await tx.insert(auditLogs).values({ id: newId(), userId, actor: 'system', entity: 'proposed_patches', entityId: patchId, action: 'fail', after: { status: 'failed', failureCode: 'VERSION_CONFLICT' } });
      return { status: 'failed' as const, code: 'VERSION_CONFLICT' };
    }
    await tx.update(statementItems).set({ matchedTransactionId: transaction.id }).where(eq(statementItems.id, item.id));
    await tx.insert(auditLogs).values([
      {
        id: auditLogId, userId, actor: 'patch', entity: 'transactions', entityId: transaction.id,
        action: 'assign_statement', before: { statementId: transaction.statementId, version: transaction.version }, after: { statementId: statement.id, version },
      },
      {
        id: newId(), userId, actor: 'patch', entity: 'statement_items', entityId: item.id,
        action: 'match', before: { matchedTransactionId: item.matchedTransactionId }, after: { matchedTransactionId: transaction.id },
      },
      {
        id: newId(), userId, actor: 'patch', entity: 'proposed_patches', entityId: patchId,
        action: 'apply', before: { status: 'proposed' }, after: { status: 'applied' },
      },
    ]);
    await recordChange(tx as unknown as Db, userId, 'transactions', transaction.id, version);
    await tx.update(proposedPatches).set({ status: 'applied', appliedAt: new Date(), appliedAuditLogId: auditLogId }).where(eq(proposedPatches.id, patchId));
    if (row.patch.candidateId) {
      await tx.update(auditCandidates).set({ decision: 'accepted' }).where(eq(auditCandidates.id, row.patch.candidateId));
      await tx.insert(auditLogs).values({
        id: newId(), userId, actor: 'user', entity: 'audit_candidates', entityId: row.patch.candidateId,
        action: 'decide', after: { decision: 'accepted', patchId },
      });
    }
    return { status: 'applied' as const, version };
  });
}

export async function completeAuditSession(db: Db, userId: string, sessionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [pendingCandidates] = await tx
      .select({ n: count() })
      .from(auditCandidates)
      .innerJoin(auditSessions, eq(auditSessions.id, auditCandidates.sessionId))
      .where(and(eq(auditSessions.id, sessionId), eq(auditSessions.userId, userId), eq(auditCandidates.decision, 'pending')));
    const [pendingPatches] = await tx
      .select({ n: count() })
      .from(proposedPatches)
      .where(and(eq(proposedPatches.sessionId, sessionId), eq(proposedPatches.userId, userId), inArray(proposedPatches.status, ['proposed', 'accepted'])));
    if ((pendingCandidates?.n ?? 0) > 0 || (pendingPatches?.n ?? 0) > 0) return false;
    const rows = await tx
      .update(auditSessions)
      .set({ status: 'completed', completedAt: new Date() })
      .where(and(eq(auditSessions.id, sessionId), eq(auditSessions.userId, userId), eq(auditSessions.status, 'reviewing')))
      .returning({ id: auditSessions.id });
    if (rows.length === 0) return false;
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'audit_sessions', entityId: sessionId,
      action: 'complete', after: { completed: true },
    });
    return true;
  });
}

export async function findImportFileForPurge(db: Db, userId: string, importFileId: string) {
  const [file] = await db.select().from(importFiles).where(and(eq(importFiles.id, importFileId), eq(importFiles.userId, userId))).limit(1);
  return file ? { storagePath: file.storagePath } : null;
}

export async function markImportFilePurgedByUser(db: Db, userId: string, importFileId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [file] = await tx.select({ status: importFiles.status }).from(importFiles).where(and(eq(importFiles.id, importFileId), eq(importFiles.userId, userId))).limit(1);
    if (!file) return;
    await tx.update(importFiles).set({ status: 'purged' }).where(and(eq(importFiles.id, importFileId), eq(importFiles.userId, userId)));
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'import_files', entityId: importFileId,
      action: 'purge', before: { status: file.status }, after: { status: 'purged' },
    });
  });
}

export async function markAuditImportFailed(
  db: Db,
  userId: string,
  importFileId: string,
  sessionId: string,
  errorCode: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(importFiles).set({ status: 'failed', errorCode }).where(and(eq(importFiles.id, importFileId), eq(importFiles.userId, userId)));
    await tx.update(auditSessions).set({ status: 'reviewing', stats: { errorCode } }).where(and(eq(auditSessions.id, sessionId), eq(auditSessions.userId, userId)));
    await tx.insert(auditLogs).values([
      { id: newId(), userId, actor: 'system', entity: 'import_files', entityId: importFileId, action: 'fail', after: { status: 'failed', errorCode } },
      { id: newId(), userId, actor: 'system', entity: 'audit_sessions', entityId: sessionId, action: 'fail', after: { status: 'reviewing', errorCode } },
    ]);
  });
}

export async function listExpiredImportFiles(db: Db, today: string) {
  return db
    .select({ id: importFiles.id, userId: importFiles.userId, storagePath: importFiles.storagePath })
    .from(importFiles)
    .where(and(lte(importFiles.retainUntil, today), inArray(importFiles.status, ['uploaded', 'parsed', 'failed'])));
}

export async function markImportFilePurgedBySystem(db: Db, userId: string, importFileId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(importFiles).set({ status: 'purged' }).where(and(eq(importFiles.id, importFileId), eq(importFiles.userId, userId)));
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'system', entity: 'import_files', entityId: importFileId,
      action: 'retention_purge', after: { status: 'purged' },
    });
  });
}
