export const IMPORT_LIMITS = {
  maxCharacters: 5_000_000,
  maxRows: 10_000,
  maxColumns: 100,
  maxCellCharacters: 65_536,
} as const;

export type CsvColumn =
  | 'sourceId'
  | 'occurredAt'
  | 'postedAt'
  | 'merchant'
  | 'amount'
  | 'currency'
  | 'type'
  | 'accountHint'
  | 'cardLast4'
  | 'installment';

export interface StatementDefaults {
  currency?: string;
  institution?: string;
  cardLast4?: string;
  periodStart?: string;
  periodEnd?: string;
  statementDate?: string;
  dueDate?: string;
  total?: string;
}

export type ImportInput =
  | {
      kind: 'csv';
      text: string;
      filename?: string;
      delimiter?: ',' | ';' | '\t';
      columns?: Partial<Record<CsvColumn, string>>;
      defaults?: StatementDefaults;
    }
  | { kind: 'text'; text: string; defaults?: StatementDefaults }
  | { kind: 'pdf'; extractedText: string; filename?: string; defaults?: StatementDefaults };

export interface ParseWarning {
  code: 'ROW_SKIPPED' | 'FIELD_IGNORED';
  line: number;
  message: string;
  raw?: string;
}

export type ImportedTransactionType = 'purchase' | 'refund' | 'fee' | 'installment' | 'payment' | 'other';

export interface ImportedTransaction {
  sourceId?: string;
  institution?: string;
  accountHint?: string;
  cardLast4?: string;
  occurredAt?: string;
  postedAt?: string;
  merchantRaw: string;
  merchantNormalized?: string;
  amountMinor: bigint;
  currency: string;
  type?: ImportedTransactionType;
  installment?: { current: number; total: number };
  metadata: Record<string, unknown>;
}

export interface NormalizedStatement {
  importerId: string;
  institution?: string;
  cardLast4?: string;
  periodStart?: string;
  periodEnd?: string;
  statementDate?: string;
  dueDate?: string;
  totalMinor?: bigint;
  currency: string;
  transactions: ImportedTransaction[];
}

export interface ParseResult {
  statement: NormalizedStatement;
  warnings: ParseWarning[];
}

export interface Importer {
  id: string;
  displayName: string;
  accepts: ('csv' | 'pdf' | 'text')[];
  detect(input: ImportInput): number;
  parse(input: ImportInput): Promise<ParseResult>;
}

export class ImporterError extends Error {
  constructor(
    public readonly code: 'INPUT_TOO_LARGE' | 'TOO_MANY_ROWS' | 'TOO_MANY_COLUMNS' | 'CELL_TOO_LARGE' | 'FORMAT_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ImporterError';
  }
}
