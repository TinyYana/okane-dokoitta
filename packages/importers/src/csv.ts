import { IMPORT_LIMITS, ImporterError } from './types.js';

export interface CsvRow {
  line: number;
  cells: string[];
}

export function parseCsv(text: string, delimiter: ',' | ';' | '\t'): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  const pushCell = () => {
    if (cell.length > IMPORT_LIMITS.maxCellCharacters) {
      throw new ImporterError('CELL_TOO_LARGE', `第 ${rowLine} 行儲存格超過 ${IMPORT_LIMITS.maxCellCharacters} 字元`);
    }
    row.push(cell);
    cell = '';
    if (row.length > IMPORT_LIMITS.maxColumns) {
      throw new ImporterError('TOO_MANY_COLUMNS', `第 ${rowLine} 行超過 ${IMPORT_LIMITS.maxColumns} 欄`);
    }
  };
  const pushRow = () => {
    pushCell();
    if (row.some((value) => value.length > 0)) rows.push({ line: rowLine, cells: row });
    row = [];
    rowLine = line + 1;
    if (rows.length > IMPORT_LIMITS.maxRows) {
      throw new ImporterError('TOO_MANY_ROWS', `輸入超過 ${IMPORT_LIMITS.maxRows} 列上限`);
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else {
        cell += char;
        if (char === '\n') line += 1;
      }
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === delimiter) pushCell();
    else if (char === '\n') {
      pushRow();
      line += 1;
    } else if (char !== '\r') cell += char;
  }
  if (quoted) throw new ImporterError('FORMAT_INVALID', `第 ${rowLine} 行引號未關閉`);
  if (cell.length > 0 || row.length > 0) pushRow();
  return rows;
}
