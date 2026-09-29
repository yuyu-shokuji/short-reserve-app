// 予約から「ショートステイ 記録表①／②」を1日ぶん作る。
//
// 様式は罫線・結合・フォントが細かいので、現場の見本から取り出したひな形
// （lib/record-templates/rec1.json・rec2.json）をそのまま敷き直している。
// 差し替えるのは 日付・居室名・利用者名・来所帰所 だけ。
// ⚠️ 様式が変わったときは scripts/extract-template.py で JSON を作り直すこと。
//    ここで罫線や結合を書き起こそうとしないこと（必ずずれる）。

import ExcelJS from 'exceljs';
import { readSheets, SHEET } from './sheets';
import rec1 from './record-templates/rec1.json';
import rec2 from './record-templates/rec2.json';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n: number) => String(n).padStart(2, '0');

interface Template {
  rows: number; cols: number;
  rowHeights: Record<string, number>;
  colWidths: Record<string, number>;
  merges: number[][];
  styles: any[];
  cells: { r: number; c: number; v?: string | number; s?: number }[];
  page: any;
}

/** ひな形ごとの、差し替える場所。見本の行・列をそのまま持っている。 */
const FORMS = {
  '1': {
    tpl: rec1 as unknown as Template,
    label: '記録表①',
    date: { year: 11, month: 13, day: 15, dow: 17 },   // K / M / O / Q
    roomRows: [5, 8, 11, 14, 17, 20, 23, 26, 29, 32],
    colRoom: 2, colName: 3, colVisit: 33,              // B / C / AG
  },
  '2': {
    tpl: rec2 as unknown as Template,
    label: '記録表②',
    date: { year: 11, month: 13, day: 15, dow: 16 },   // K / M / O / P
    roomRows: [5, 9, 13, 17, 21, 25, 29, 33, 37, 41],
    colRoom: 2, colName: 3, colVisit: 0,               // ②に来所帰所の欄は無い
  },
} as const;

export type FormKey = keyof typeof FORMS;

/** その日、どの部屋に誰がいるか。棟 → 部屋番号 → 予約。 */
async function occupantsOf(day: string) {
  const data = await readSheets([SHEET.reserve, SHEET.rooms]);
  const cell = (r: any[], i: number) => String(r?.[i] ?? '').trim();
  const head = (rows: any[][]) => (rows[0] ?? []).map((c: any) => String(c ?? '').trim());

  const roomRows = data[SHEET.rooms] ?? [];
  const rh = head(roomRows);
  const units: string[] = [];
  for (const r of roomRows.slice(1)) {
    const b = cell(r, rh.indexOf('棟'));
    if (!b || cell(r, rh.indexOf('仮置き'))) continue;   // 仮置きは様式に無いので出さない
    if (!units.includes(b)) units.push(b);
  }

  const resRows = data[SHEET.reserve] ?? [];
  const ph = head(resRows);
  const by = new Map<string, { name: string; start: string; end: string; inTime: string; outTime: string }>();
  for (const r of resRows.slice(1)) {
    const name = cell(r, ph.indexOf('氏名'));
    const start = cell(r, ph.indexOf('開始日'));
    const end = cell(r, ph.indexOf('終了日'));
    if (!name || !start || !end) continue;
    if (day < start || day > end) continue;
    by.set(`${cell(r, ph.indexOf('棟'))}-${Number(r[ph.indexOf('部屋')])}`, {
      name, start, end,
      inTime: cell(r, ph.indexOf('入所時間')),
      outTime: cell(r, ph.indexOf('退所時間')),
    });
  }
  return { units, by };
}

/** 来所・帰所の欄。入所日なら来所、退所日なら帰所。時刻が無ければ枠だけ。 */
function visitLabel(day: string, o?: { start: string; end: string; inTime: string; outTime: string }): string {
  if (!o) return '';
  const parts: string[] = [];
  if (day === o.start) parts.push(`来所${o.inTime || '　　:'}`);
  if (day === o.end) parts.push(`帰所${o.outTime || '　　:'}`);
  return parts.join(' ');
}

export interface RecordSheet { buffer: Buffer; filename: string; day: string; filled: number; }

/** 日付を渡すと、その日の記録表（①か②）を組み立てて返す。 */
export async function buildRecordSheet(day: string, form: FormKey): Promise<RecordSheet> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日付は YYYY-MM-DD で渡してください');
  const f = FORMS[form];
  const t = f.tpl;
  const [y, m, d] = day.split('-').map(Number);
  const dow = WD[new Date(y, m - 1, d).getDay()];
  const { units, by } = await occupantsOf(day);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'グラン悠遊 ショート予約台帳';
  const ws = wb.addWorksheet(`${m}月${d}日`, {
    pageSetup: {
      orientation: t.page.orientation, paperSize: t.page.paperSize,
      fitToPage: true, fitToWidth: t.page.fitToWidth, fitToHeight: t.page.fitToHeight,
      margins: t.page.margins,
    },
  });

  for (const [c, w] of Object.entries(t.colWidths)) ws.getColumn(Number(c)).width = w;

  let filled = 0;
  units.forEach((unit, ui) => {
    const off = ui * t.rows;                       // 棟ごとに1ブロックずつ下へ積む

    for (const [r, h] of Object.entries(t.rowHeights)) ws.getRow(off + Number(r)).height = h;

    for (const cl of t.cells) {
      const cell = ws.getCell(off + cl.r, cl.c);
      if (cl.v !== undefined) cell.value = cl.v as any;
      if (cl.s !== undefined) cell.style = { ...(t.styles[cl.s] as any) };
    }
    for (const [r1, c1, r2, c2] of t.merges) ws.mergeCells(off + r1, c1, off + r2, c2);

    // 日付
    ws.getCell(off + 1, f.date.year).value = `${y}年`;
    ws.getCell(off + 1, f.date.month).value = m;
    ws.getCell(off + 1, f.date.day).value = d;
    ws.getCell(off + 1, f.date.dow).value = `（${dow}）`;

    // 居室と利用者
    f.roomRows.forEach((tr, i) => {
      const no = i + 1;
      const r = off + tr;
      const tplRoom = String(t.cells.find(x => x.r === tr && x.c === f.colRoom)?.v ?? '');
      // ひな形の「すみれ　　０１」の棟名だけ入れ替える（空きの入り方をそのまま残すため）
      ws.getCell(r, f.colRoom).value = tplRoom.replace(/^[^\s０-９]+/, unit);
      const o = by.get(`${unit}-${no}`);
      ws.getCell(r, f.colName).value = o ? o.name : null;
      if (o) filled++;
      if (f.colVisit) ws.getCell(r, f.colVisit).value = visitLabel(day, o) || null;
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(buf as ArrayBuffer),
    filename: `${f.label}_${y}-${pad2(m)}-${pad2(d)}.xlsx`,
    day, filled,
  };
}
