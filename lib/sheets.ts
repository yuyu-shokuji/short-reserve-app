// Googleスプレッドシートの読み書き。
// meal-app の lib/sheets-client.ts から、予約台帳に要る部分だけを持ってきたもの。
// 対象月の上書き(x-ym/クッキー)・単価設定・スプレッドシート新規作成は不要なので入れていない
// （このアプリは年月を必ず画面から明示的に受け取る）。

import { google } from 'googleapis';
import path from 'path';

// ── 設定スプレッドシート（永続固定・月レジストリと予約台帳の置き場） ──────
// 6月のスプレッドシートをアンカーとして使う。削除禁止。
export const CONFIG_SPREADSHEET_ID = '1zEgwHuqkBoiMKE5WWqGLZSEa7w9ItCw916ne645NvGY';
const REGISTRY_SHEET = '月レジストリ';

// 予約台帳は ショート_記録 へ書き出すので読み書き権限が要る（厨房・経理アプリは読み取りのみ）。
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let _sheets: ReturnType<typeof google.sheets> | null = null;

async function getAuth(): Promise<InstanceType<typeof google.auth.GoogleAuth>> {
  const jsonEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    return new google.auth.GoogleAuth({ credentials: JSON.parse(jsonEnv), scopes: SCOPES });
  }
  // ローカル開発用。Vercelでは上の環境変数を使う。
  const keyFile = path.join(process.cwd(), '..', 'sheets-migration', 'service-account-key.json');
  return new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
}

async function getSheetsClient() {
  if (_sheets) return _sheets;
  _sheets = google.sheets({ version: 'v4', auth: await getAuth() });
  return _sheets;
}

// ── 一時的なAPIエラーの自動リトライ ─────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function isRetryable(e: any): boolean {
  const code = Number(e?.code ?? e?.response?.status ?? e?.status);
  return code === 429 || code === 500 || code === 503;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (i === tries - 1 || !isRetryable(e)) throw e;
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}

// ── 月レジストリ（どの月がどのスプレッドシートか） ─────────────────────
export type MonthEntry = { year: number; month: number; spreadsheetId: string };

let _months: MonthEntry[] | null = null;
let _monthsAt = 0;
const REGISTRY_TTL = 60000;   // 月の追加は稀

/** 登録済み月の一覧（昇順）。 */
export async function listSheetMonths(): Promise<MonthEntry[]> {
  const now = Date.now();
  if (_months && now - _monthsAt < REGISTRY_TTL) return _months;
  const sh = await getSheetsClient();
  const res = await withRetry(() => sh.spreadsheets.values.get({
    spreadsheetId: CONFIG_SPREADSHEET_ID,
    range: `'${REGISTRY_SHEET}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  }));
  const rows: any[][] = res.data.values ?? [];
  _months = rows.slice(1)
    .filter(r => r[0] && r[1] && r[2])
    .map(r => ({ year: Number(r[0]), month: Number(r[1]), spreadsheetId: String(r[2]) }))
    .sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month));
  _monthsAt = now;
  return _months;
}

/** その年月のスプレッドシートID。未登録なら投げる。 */
export async function resolveSpreadsheetId(year: number, month: number): Promise<string> {
  const months = await listSheetMonths();
  const entry = months.find(m => m.year === year && m.month === month);
  if (!entry) throw new Error(`${year}年${month}月のスプレッドシートが未登録です`);
  return entry.spreadsheetId;
}

// ── A1 記法ヘルパー ──────────────────────────────────────────────────

function colLetter(c: number): string {
  let s = '';
  c++;
  while (c > 0) {
    c--;
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26);
  }
  return s;
}

/** 0始まりの行・列 → A1 記法セル（例: r=0, c=0 → 'A1'） */
function cellA1(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

function rangeStr(sheet: string, cell: string): string {
  return `'${sheet}'!${cell}`;
}

// ── 読み取り（短時間キャッシュ・書き込みで無効化） ───────────────────
// Sheets API の「1分あたりの読み取り回数（60回/ユーザー）」対策。
const READ_TTL = 12000;
const _readCache = new Map<string, { at: number; data: Record<string, any[][]> }>();

function readKey(sid: string, names: string[]): string {
  return sid + '::' + [...names].sort().join('|');
}

function invalidateReadCache(sid: string): void {
  for (const k of [..._readCache.keys()]) {
    if (k.startsWith(sid + '::')) _readCache.delete(k);
  }
}

function cloneData(d: Record<string, any[][]>): Record<string, any[][]> {
  const out: Record<string, any[][]> = {};
  for (const k of Object.keys(d)) out[k] = d[k].map(r => [...r]);
  return out;
}

/** 指定シート群を AOA（配列の配列）で取得。末尾空セルを最大列幅まで '' でパディング。 */
export async function readSheets(
  sheetNames: string[],
  spreadsheetId: string,
): Promise<Record<string, any[][]>> {
  const key = readKey(spreadsheetId, sheetNames);
  const cached = _readCache.get(key);
  if (cached && Date.now() - cached.at < READ_TTL) return cloneData(cached.data);

  const sh = await getSheetsClient();
  const res = await withRetry(() => sh.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: sheetNames.map(n => `'${n}'`),
    valueRenderOption: 'UNFORMATTED_VALUE',
  }));
  const out: Record<string, any[][]> = {};
  (res.data.valueRanges ?? []).forEach((vr: any, i: number) => {
    const rows: any[][] = vr.values ?? [];
    const maxLen = rows.reduce((m: number, r: any[]) => Math.max(m, r.length), 0);
    out[sheetNames[i]] = rows.map((r: any[]) => {
      const rr = [...r];
      while (rr.length < maxLen) rr.push('');
      return rr;
    });
  });
  _readCache.set(key, { at: Date.now(), data: cloneData(out) });
  return out;
}

// ── 書き込み ─────────────────────────────────────────────────────────

export interface CellWrite { sheet: string; row: number; col: number; value: any; }
export interface CellClear { sheet: string; row: number; col: number; }

/** 複数セルの書き込み/クリアをまとめて送信（row/col は0始まり）。 */
export async function batchWrite(
  writes: CellWrite[],
  clears: CellClear[],
  spreadsheetId: string,
): Promise<void> {
  const sh = await getSheetsClient();

  if (writes.length > 0) {
    await withRetry(() => sh.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: writes.map(w => ({ range: rangeStr(w.sheet, cellA1(w.row, w.col)), values: [[w.value]] })),
      },
    }));
  }

  if (clears.length > 0) {
    await withRetry(() => sh.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges: clears.map(c => rangeStr(c.sheet, cellA1(c.row, c.col))) },
    }));
  }
  invalidateReadCache(spreadsheetId);
}

/** シート全体を AOA で上書き（行の削除に使う。clear→update の順で古い行を残さない）。 */
export async function writeSheetAoa(
  sheetName: string,
  aoa: any[][],
  spreadsheetId: string,
): Promise<void> {
  const sh = await getSheetsClient();
  await withRetry(() => sh.spreadsheets.values.clear({
    spreadsheetId, range: `'${sheetName}'`,
  }));
  await withRetry(() => sh.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: aoa.map((r: any[]) => r.map((c: any) => c ?? '')) },
  }));
  invalidateReadCache(spreadsheetId);
}

/** シートが無ければ作成してヘッダー行を書く。 */
export async function ensureSheetExists(
  sheetName: string, header: any[], spreadsheetId: string,
): Promise<void> {
  const sh = await getSheetsClient();
  const meta = await withRetry(() => sh.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }));
  const names = (meta.data.sheets ?? []).map((s: any) => s.properties?.title ?? '');
  if (names.includes(sheetName)) return;
  await withRetry(() => sh.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  }));
  if (header.length) {
    await withRetry(() => sh.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    }));
  }
  invalidateReadCache(spreadsheetId);
}
