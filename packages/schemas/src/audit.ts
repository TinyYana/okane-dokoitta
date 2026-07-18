import { z } from 'zod';
import { zUuidV7 } from './common.js';

const zCivilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zImporterDefaults = z.object({
  currency: z.string().length(3).default('TWD'),
  institution: z.string().max(100).optional(),
  cardLast4: z.string().regex(/^\d{4}$/).optional(),
  periodStart: zCivilDate.optional(),
  periodEnd: zCivilDate.optional(),
  statementDate: zCivilDate.optional(),
  dueDate: zCivilDate.optional(),
  total: z.string().regex(/^-?\d+(?:\.\d+)?$/).optional(),
});

export const zAuditImport = z.object({
  kind: z.enum(['csv', 'text', 'pdf']),
  text: z.string().min(1).max(5_000_000),
  /** AI 整理前的原始來源；有值時加密保存它，text 只作為已確認的解析稿。 */
  sourceText: z.string().min(1).max(5_000_000).optional(),
  filename: z.string().trim().min(1).max(255).default('pasted-statement.txt'),
  importerId: z.enum(['auto', 'generic-csv', 'generic-text', 'union-bank-credit-card']),
  creditCardAccountId: zUuidV7,
  delimiter: z.enum([',', ';', '\t']).optional(),
  columns: z.record(z.string(), z.string().max(100)).optional(),
  defaults: zImporterDefaults,
});

export const zPatchDecision = z.object({
  accept: z.boolean(),
  categoryAccountId: zUuidV7.optional(),
});
