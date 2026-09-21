// 予約台帳アプリ専用スプレッドシートの読み書き。
//
// このアプリは食事管理アプリとは別のスプレッドシート1つだけを見る（まずは単体で作るため）。
// 食事管理側のデータには一切触らない。連動は後で足す。

import { google } from 'googleapis';
import path from 'path';

/**
 * 予約台帳スプレッドシートのID（このアプリ専用。食事管理のファイルとは別物）。
 * 「ショート予約台帳」＝ yuyu.shokuji のドライブにあり meal-bot に編集権限を共有ずみ。
 * 環境変数 RESERVE_SPREADSHEET_ID があればそちらが優先（公開時に差し替えられるように）。
 */
export const RESERVE_SPREADSHEET_ID =
  process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';

export const SHEET = {
  reserve: '予約',
  people: '利用者',
  rooms: '部屋',
  /** 消した予約の退避先。消しっぱなしにせず1行ずつ積む（あとから拾い直せるように）。 */
  trash: '削除ログ',
} as const;

function assertConfigured(): string {
  if (!RESERVE_SPREADSHEET_ID || RESERVE_SPREADSHEET_ID === '__SET_ME__') {
    throw new Error(
      '予約台帳スプレッドシートが未設定です。lib/sheets.ts の RESERVE_SPREADSHEET_ID に、' +
      'scripts/setup-spreadsheet.mjs で用意したスプレッドシートのIDを入れてください',
    );
  }
  return RESERVE_SPREADSHEET_ID;
}

// 予約の登録・変更しかしないので、必要な権限はスプレッドシートの読み書きだけ。
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let _sheets: ReturnType<typeof google.sheets> | null = null;

async function getAuth(): Promise<InstanceType<typeof google.auth.GoogleAuth>> {
  const jsonEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    return new google.auth.GoogleAuth({ credentials: JSON.parse(jsonEnv), scopes: SCOPES });
  }
  // ローカル開発用。公開時は上の環境変数を使う。
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
// Sheets API の「1分あたりの読み取り回数」対策。自分の書き込みは即反映される。
const READ_TTL = 8000;
let _cache: { at: number; key: string; data: Record<string, any[][]> } | null = null;

function invalidate(): void { _cache = null; }

function clone(d: Record<string, any[][]>): Record<string, any[][]> {
  const out: Record<string, any[][]> = {};
  for (const k of Object.keys(d)) out[k] = d[k].map(r => [...r]);
  return out;
}

/** 指定シート群を AOA（配列の配列）で取得。末尾空セルを最大列幅まで '' でパディング。 */
export async function readSheets(sheetNames: string[]): Promise<Record<string, any[][]>> {
  const sid = assertConfigured();
  const key = [...sheetNames].sort().join('|');
  if (_cache && _cache.key === key && Date.now() - _cache.at < READ_TTL) return clone(_cache.data);

  const sh = await getSheetsClient();
  const res = await withRetry(() => sh.spreadsheets.values.batchGet({
    spreadsheetId: sid,
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
  _cache = { at: Date.now(), key, data: clone(out) };
  return out;
}

// ── 書き込み ─────────────────────────────────────────────────────────

export interface CellWrite { sheet: string; row: number; col: number; value: any; }
export interface CellClear { sheet: string; row: number; col: number; }

/** 複数セルの書き込み/クリアをまとめて送信（row/col は0始まり）。 */
export async function batchWrite(writes: CellWrite[], clears: CellClear[] = []): Promise<void> {
  const sid = assertConfigured();
  const sh = await getSheetsClient();

  if (writes.length > 0) {
    await withRetry(() => sh.spreadsheets.values.batchUpdate({
      spreadsheetId: sid,
      requestBody: {
        valueInputOption: 'RAW',
        data: writes.map(w => ({ range: rangeStr(w.sheet, cellA1(w.row, w.col)), values: [[w.value]] })),
      },
    }));
  }

  if (clears.length > 0) {
    await withRetry(() => sh.spreadsheets.values.batchClear({
      spreadsheetId: sid,
      requestBody: { ranges: clears.map(c => rangeStr(c.sheet, cellA1(c.row, c.col))) },
    }));
  }
  invalidate();
}

/** シートが無ければ作ってヘッダー行を書く（削除ログのような後付けシート用）。 */
export async function ensureSheetExists(sheetName: string, header: any[]): Promise<void> {
  const sid = assertConfigured();
  const sh = await getSheetsClient();
  const meta = await withRetry(() => sh.spreadsheets.get({ spreadsheetId: sid, fields: 'sheets.properties.title' }));
  const names = (meta.data.sheets ?? []).map((s: any) => s.properties?.title ?? '');
  if (names.includes(sheetName)) return;
  await withRetry(() => sh.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  }));
  if (header.length) {
    await withRetry(() => sh.spreadsheets.values.update({
      spreadsheetId: sid, range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW', requestBody: { values: [header] },
    }));
  }
  invalidate();
}

/** シートの末尾に1行足す（読み取り不要。ログのように積むだけの用途に使う）。 */
export async function appendRow(sheetName: string, row: any[]): Promise<void> {
  const sid = assertConfigured();
  const sh = await getSheetsClient();
  await withRetry(() => sh.spreadsheets.values.append({
    spreadsheetId: sid,
    range: `'${sheetName}'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row.map(c => c ?? '')] },
  }));
  invalidate();
}

/** シート全体を AOA で上書き（行の削除に使う。clear→update の順で古い行を残さない）。 */
export async function writeSheetAoa(sheetName: string, aoa: any[][]): Promise<void> {
  const sid = assertConfigured();
  const sh = await getSheetsClient();
  await withRetry(() => sh.spreadsheets.values.clear({ spreadsheetId: sid, range: `'${sheetName}'` }));
  await withRetry(() => sh.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: aoa.map((r: any[]) => r.map((c: any) => c ?? '')) },
  }));
  invalidate();
}
