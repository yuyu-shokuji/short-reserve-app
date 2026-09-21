// 月シート「ショート_記録」「ショート_名」の構造。
// meal-app の lib/dept-excel.ts と同じ前提なので、あちらを変えるときはここも合わせること。
//
// ショート_記録
//   行0 … 日付（各ブロックの先頭列に 1, 2, 3 …）
//   行1 … 曜日
//   行2 … 見出し
//   行3〜… 部屋1行ずつ（さくら10室 → すみれ10室 の計20行）
//   列0 … 棟名／列1 … 部屋／列2 … 種類／列3〜 … 日付ごとに5列ずつ
//   日付ブロックの5列: 0=氏名 1=朝 2=昼 3=おやつ 4=夕
//   食事セル: 1＝その日の氏名の人が食べる／別の氏名＝その食事だけ別人（同日交代）／空＝食べない

import { readSheets, resolveSpreadsheetId, listSheetMonths } from './sheets';

export const SHORT_FIXED  = 3;
export const SHORT_N      = 5;
export const SHORT_DATA_R = 3;
export const SHORT_SAKURA = 10;
export const SHORT_SUMIRE = 10;

export const BUILDINGS = ['さくら', 'すみれ'] as const;

/** ショートの部屋（さくら10室 → すみれ10室）。台帳の表もこの並びで出す。 */
export const SHORT_ROOMS: { building: string; room: number }[] = [
  ...Array.from({ length: SHORT_SAKURA }, (_, i) => ({ building: 'さくら', room: i + 1 })),
  ...Array.from({ length: SHORT_SUMIRE }, (_, i) => ({ building: 'すみれ', room: i + 1 })),
];

/** ショート_記録の列番号（date は1始まり、colInDay は 0=氏名 1=朝 2=昼 3=おやつ 4=夕） */
export function shortMealCol(date: number, colInDay: number): number {
  return SHORT_FIXED + (date - 1) * SHORT_N + colInDay;
}

/** 棟・部屋から ショート_記録 の行番号を探す。無ければ -1。 */
export function findShortRow(rows: any[][], building: string, roomNum: number): number {
  for (let i = SHORT_DATA_R; i < SHORT_DATA_R + SHORT_SAKURA + SHORT_SUMIRE; i++) {
    if (String(rows[i]?.[0]) === building && Number(rows[i]?.[1]) === roomNum) return i;
  }
  return -1;
}

// ── 利用者名簿（氏名の候補に使う。読み取りのみ） ─────────────────────

const HIDDEN_HEADER = '非表示';

/**
 * ショートの利用者名（非表示を除く・ふりがな順）。
 * 予約は先の月ぶんも入れるので、名簿は「登録済みの最新の月」から読む
 * （新しく入った人がいちばん載っているため）。
 */
export async function getShortOccupants(): Promise<string[]> {
  const months = await listSheetMonths();
  if (!months.length) return [];
  const latest = months[months.length - 1];
  const nameRows = (await readSheets(['ショート_名'], latest.spreadsheetId))['ショート_名'] ?? [];
  const head = nameRows[0] ?? [];
  let hcol = head.findIndex((c: any) => String(c ?? '').trim() === HIDDEN_HEADER);
  if (hcol < 0) hcol = nameRows.reduce((m, r) => Math.max(m, r.length), 0);

  return nameRows.slice(1)
    .map((r, i) => ({
      name: String(r[0] ?? '').trim(),
      furi: String(r[1] ?? '').trim(),
      hidden: String(r[hcol] ?? '').trim() !== '',
      i,
    }))
    .filter(x => x.name && !x.hidden)
    .sort((a, b) => {
      if (!a.furi && b.furi) return 1;
      if (a.furi && !b.furi) return -1;
      return a.furi.localeCompare(b.furi, 'ja') || a.i - b.i;
    })
    .map(x => x.name);
}

// ── 月シートの全体一覧（書き出した結果の確認用・読み取り専用） ──────────

// m/l/d＝その食事を食べる人。occ＝その日その部屋にいる人（食べない日も入る）。
export interface OverviewDay { m: string; l: string; d: string; occ: string; }
export interface MonthOverview {
  year: number;
  month: number;
  daysInMonth: number;
  rooms: { building: string; roomNum: number; days: OverviewDay[] }[];
}

/** その月の ショート_記録 を部屋×日付で読む。書き込みは一切しない。 */
export async function getMonthOverview(year: number, month: number): Promise<MonthOverview> {
  const sid = await resolveSpreadsheetId(year, month);
  const rows = (await readSheets(['ショート_記録'], sid))['ショート_記録'] ?? [];
  const daysInMonth = new Date(year, month, 0).getDate();

  const eaterOf = (row: any[], date: number, mealColInDay: number): string => {
    const name = String(row[shortMealCol(date, 0)] ?? '').trim();
    const v = row[shortMealCol(date, mealColInDay)];
    if (v === 1 || v === '1') return name;
    const s = String(v ?? '').trim();
    return (s && s !== '1') ? s : '';
  };

  const out: MonthOverview['rooms'] = [];
  for (let i = 0; i < SHORT_SAKURA + SHORT_SUMIRE; i++) {
    const row = rows[SHORT_DATA_R + i] ?? [];
    const building = String(row[0] ?? '').trim();
    const roomNum = Number(row[1] ?? 0);
    if (!building || !roomNum) continue;
    const days: OverviewDay[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      days.push({
        m: eaterOf(row, d, 1), l: eaterOf(row, d, 2), d: eaterOf(row, d, 4),
        occ: String(row[shortMealCol(d, 0)] ?? '').trim(),
      });
    }
    out.push({ building, roomNum, days });
  }
  return { year, month, daysInMonth, rooms: out };
}
