import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { isBlank } from './normalize.js';

export const MAX_ROWS = Number(process.env.MAX_ROWS_PER_FILE || 500000);
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.status = 422;
  }
}

/** Detect the real file type from its first bytes, independent of the extension. */
export function sniffType(buf) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'xlsx';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'xls';
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) return 'binary';
  return 'csv';
}

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result); // formula
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text); // hyperlink
    if ('error' in v) return null;
    return String(v);
  }
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  return v;
}

function uniqueHeaders(raw) {
  const seen = new Map();
  return raw.map((h, i) => {
    let name = isBlank(h) ? `Column ${i + 1}` : String(h instanceof Date ? h.toISOString() : h).replace(/\s+/g, ' ').trim();
    const n = seen.get(name.toLowerCase()) || 0;
    seen.set(name.toLowerCase(), n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    return name;
  });
}

/** Header = first row (within the first 25) that has at least 2 non-empty text cells. */
function toTable(matrix) {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(matrix.length, 25); i++) {
    const nonEmpty = (matrix[i] || []).filter((c) => !isBlank(c));
    if (nonEmpty.length >= 2 && nonEmpty.filter((c) => typeof c === 'string').length >= 2) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new ParseError('Could not find a header row (expected at least two column titles near the top of the file).');
  const width = Math.max(...matrix.slice(headerIdx, headerIdx + 50).map((r) => (r || []).length));
  const headers = uniqueHeaders(Array.from({ length: width }, (_, i) => matrix[headerIdx][i]));
  const rows = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const r = matrix[i] || [];
    if (r.every((c) => isBlank(c))) continue;
    const obj = {};
    headers.forEach((h, j) => { obj[h] = isBlank(r[j]) ? null : r[j]; });
    rows.push({ rowNumber: i + 1, values: obj });
    if (rows.length > MAX_ROWS) throw new ParseError(`File has more than ${MAX_ROWS} rows. Split the export into smaller files.`);
  }
  return { headers, rows, headerRowNumber: headerIdx + 1 };
}

async function parseXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch (e) {
    throw new ParseError(`Could not read the Excel workbook: ${e.message}`);
  }
  const sheet = wb.worksheets.find((ws) => ws.actualRowCount > 1) || wb.worksheets[0];
  if (!sheet) throw new ParseError('The workbook has no worksheets.');
  const matrix = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const arr = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { arr[col - 1] = cellValue(cell.value); });
    matrix[rowNumber - 1] = arr;
  });
  return { ...toTable(matrix), sheetName: sheet.name };
}

async function parseXls(buf) {
  let XLSX;
  try {
    XLSX = await import('xlsx');
  } catch {
    throw new ParseError('Legacy .xls support needs the SheetJS package (npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz). Alternatively re-save the file as .xlsx or .csv.');
  }
  const X = XLSX.default || XLSX;
  const wb = X.read(buf, { type: 'buffer', cellNF: true, cellDates: false });
  const name = wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws || !ws['!ref']) throw new ParseError('The workbook has no data.');
  const range = X.utils.decode_range(ws['!ref']);
  const matrix = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const arr = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[X.utils.encode_cell({ r, c })];
      if (!cell) { arr.push(null); continue; }
      if (cell.t === 'n' && cell.z && X.SSF.is_date(cell.z)) arr.push(new Date(Math.round(EXCEL_EPOCH_MS + cell.v * 86400000)));
      else if (cell.t === 'e') arr.push(null);
      else arr.push(cellValue(cell.v));
    }
    matrix.push(arr);
  }
  return { ...toTable(matrix), sheetName: name };
}

function parseCsvBuffer(buf) {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t', '|'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  let records;
  try {
    records = parseCsv(text, { bom: true, delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    throw new ParseError(`Could not parse CSV: ${e.message}`);
  }
  const matrix = records.map((r) => r.map((c) => (c === '' ? null : c)));
  return { ...toTable(matrix), sheetName: null };
}

/** Parse an uploaded CDR file into { headers, rows:[{rowNumber, values}], type }. */
export async function parseCdrFile(filePath, declaredType) {
  const buf = await fs.readFile(filePath);
  const type = sniffType(buf);
  if (type === 'binary') throw new ParseError('File content is not a valid CSV, XLSX or XLS file.');
  // The content decides the format: dialer exports are often comma-separated text saved as .xls.
  const warning = declaredType && declaredType !== type ? `The file is named .${declaredType} but contains ${type === 'csv' ? 'comma-separated (CSV) text' : `an .${type} workbook`}; it was read as ${type.toUpperCase()}.` : null;
  let result;
  if (type === 'xlsx') result = await parseXlsx(buf);
  else if (type === 'xls') result = await parseXls(buf);
  else result = parseCsvBuffer(buf);
  if (result.rows.length === 0) throw new ParseError('The file has a header row but no data rows.');
  return { ...result, type, warning };
}
