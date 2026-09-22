// 予約から「入浴・洗濯管理表」を1週間ぶん組み立てる。
//
// いまの紙（ネオライフサポート ショートステイ 入浴・洗濯管理表）に合わせつつ、
// 入浴欄・洗濯欄は2セルではなく1セルにしてある（1週14列＋見出しで17列、A4横1枚）。
//
// 並びはユニット順 → 部屋番号順 → 開始日順。
// ⚠️ 同じ人でも週の途中で部屋が変われば別の行にする（現場の運用がそうなっている）。
//
// 記号（◎ 〇 ☆ △ や前回入浴日）のルールは現場に確認中。決まったらここに足す。

import ExcelJS from 'exceljs';
import { readSheets, SHEET } from './sheets';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 渡した日を含む週の日曜。 */
export function sundayOf(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error('日付は YYYY-MM-DD で渡してください');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() - d.getDay());
  return isoOf(d);
}

// 滞在している日の色。入浴は濃いグレー、洗濯は薄いグレー（現場の指定）。
const GRAY = { head: 'FFD9D9D9', bathHead: 'FFBFBFBF', bath: 'FFA6A6A6', wash: 'FFD9D9D9' };
const FONT = 'Yu Gothic';
const solid = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } }) as const;
const thin = { style: 'thin', color: { argb: 'FF808080' } } as const;
const med = { style: 'medium', color: { argb: 'FF404040' } } as const;

interface Row { name: string; building: string; room: number; start: string; end: string; status: string; }

/** その週にかかる予約を、表に出す順に並べて返す。 */
async function weekRows(weekStart: string, weekEnd: string): Promise<Row[]> {
  const data = await readSheets([SHEET.reserve, SHEET.rooms]);
  const cell = (r: any[], i: number) => String(r?.[i] ?? '').trim();
  const head = (rows: any[][]) => (rows[0] ?? []).map((c: any) => String(c ?? '').trim());

  const roomRows = data[SHEET.rooms] ?? [];
  const rh = head(roomRows);
  const roomOrder = new Map<string, number>();
  const buildingOrder = new Map<string, number>();
  roomRows.slice(1).forEach((r, i) => {
    const b = cell(r, rh.indexOf('棟'));
    const no = Number(r[rh.indexOf('部屋')]);
    if (!b || !no) return;
    if (cell(r, rh.indexOf('仮置き'))) return;      // 仮置きは実在しないので出さない
    if (!buildingOrder.has(b)) buildingOrder.set(b, buildingOrder.size);
    roomOrder.set(`${b}-${no}`, i);
  });

  const resRows = data[SHEET.reserve] ?? [];
  const ph = head(resRows);
  return resRows.slice(1)
    .map(r => ({
      name: cell(r, ph.indexOf('氏名')),
      building: cell(r, ph.indexOf('棟')),
      room: Number(r[ph.indexOf('部屋')]),
      start: cell(r, ph.indexOf('開始日')),
      end: cell(r, ph.indexOf('終了日')),
      status: cell(r, ph.indexOf('状態')),
    }))
    .filter(r => r.name && r.start && r.end)
    .filter(r => r.start <= weekEnd && r.end >= weekStart)
    .filter(r => roomOrder.has(`${r.building}-${r.room}`))
    .sort((a, b) =>
      (buildingOrder.get(a.building) ?? 99) - (buildingOrder.get(b.building) ?? 99)
      || a.room - b.room
      || a.start.localeCompare(b.start));
}

export interface BathSheet { buffer: Buffer; filename: string; weekStart: string; count: number; }

/** 日曜を渡すと、その週の入浴・洗濯管理表を組み立てて返す。 */
export async function buildBathSheet(day: string): Promise<BathSheet> {
  const weekStart = sundayOf(day);
  const [y, m, d] = weekStart.split('-').map(Number);
  const days = Array.from({ length: 7 }, (_, i) => {
    const x = new Date(y, m - 1, d); x.setDate(x.getDate() + i); return x;
  });
  const weekEnd = isoOf(days[6]);
  const rows = await weekRows(weekStart, weekEnd);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'グラン悠遊 ショート予約台帳';
  const ws = wb.addWorksheet(weekStart, {
    pageSetup: {
      paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    },
  });

  // A=余白 / B=ユニット / C=氏名 / D〜Q=7日×2列 / R=期間
  const DAY0 = 4;
  const colOf = (i: number, kind: 'bath' | 'wash') => DAY0 + i * 2 + (kind === 'wash' ? 1 : 0);
  const LAST = colOf(6, 'wash') + 1;
  ws.getColumn(1).width = 2.5;
  ws.getColumn(2).width = 7.5;
  ws.getColumn(3).width = 18;
  for (let i = 0; i < 7; i++) { ws.getColumn(colOf(i, 'bath')).width = 5; ws.getColumn(colOf(i, 'wash')).width = 5; }
  ws.getColumn(LAST).width = 10;

  ws.mergeCells(1, 2, 1, LAST);
  const t = ws.getCell(1, 2);
  t.value = 'ネオライフサポート　ショートステイ　入浴・洗濯管理表';
  t.font = { name: FONT, size: 14, bold: true };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 26;

  ws.mergeCells(2, 2, 2, LAST);
  const sub = ws.getCell(2, 2);
  sub.value = `${days[0].getFullYear()}年${days[0].getMonth() + 1}月${days[0].getDate()}日（日）〜`
    + `${days[6].getMonth() + 1}月${days[6].getDate()}日（土）`;
  sub.font = { name: FONT, size: 11 };
  sub.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 18;
  ws.getRow(3).height = 6;

  const HEAD = 4;
  const headCell = (r: number, c: number, v: string, fill: string) => {
    const cl = ws.getCell(r, c);
    cl.value = v;
    cl.font = { name: FONT, size: 10, bold: true };
    cl.alignment = { horizontal: 'center', vertical: 'middle' };
    cl.fill = solid(fill);
  };
  ws.mergeCells(HEAD, 2, HEAD + 2, 2); headCell(HEAD, 2, 'ユニット', GRAY.head);
  ws.mergeCells(HEAD, 3, HEAD + 2, 3); headCell(HEAD, 3, '利用者名', GRAY.head);
  ws.mergeCells(HEAD, LAST, HEAD + 2, LAST); headCell(HEAD, LAST, '期間', GRAY.head);
  for (let i = 0; i < 7; i++) {
    const c0 = colOf(i, 'bath'), c1 = colOf(i, 'wash');
    ws.mergeCells(HEAD, c0, HEAD, c1);
    headCell(HEAD, c0, `${days[i].getMonth() + 1}/${days[i].getDate()}`, GRAY.head);
    ws.mergeCells(HEAD + 1, c0, HEAD + 1, c1);
    headCell(HEAD + 1, c0, WD[i], GRAY.head);
    headCell(HEAD + 2, c0, '入浴', GRAY.bathHead);
    headCell(HEAD + 2, c1, '洗濯', GRAY.head);
  }
  ws.getRow(HEAD).height = 18;
  ws.getRow(HEAD + 1).height = 16;
  ws.getRow(HEAD + 2).height = 16;

  const FIRST = HEAD + 3;
  rows.forEach((rv, i) => {
    const r = FIRST + i;
    ws.getRow(r).height = 19;

    const unit = ws.getCell(r, 2);
    unit.value = `${rv.building}${pad2(rv.room)}`;
    unit.font = { name: FONT, size: 10 };
    unit.alignment = { horizontal: 'center', vertical: 'middle' };
    unit.fill = solid(GRAY.head);

    const nm = ws.getCell(r, 3);
    nm.value = `${rv.name}　様`;
    nm.font = { name: FONT, size: 11 };
    nm.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

    for (let i2 = 0; i2 < 7; i2++) {
      const day = isoOf(days[i2]);
      const staying = day >= rv.start && day <= rv.end;
      for (const kind of ['bath', 'wash'] as const) {
        const c = ws.getCell(r, colOf(i2, kind));
        c.font = { name: FONT, size: 12 };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        if (staying) c.fill = solid(kind === 'bath' ? GRAY.bath : GRAY.wash);
      }
    }

    // 期間＝滞在予定の最終日。
    // ⚠️ exceljs は Date を UTC として書くので、地元時間の Date を渡すと1日前になる。
    const ed = ws.getCell(r, LAST);
    const [ey, em, edd] = rv.end.split('-').map(Number);
    ed.value = new Date(Date.UTC(ey, em - 1, edd));
    ed.numFmt = 'm"月"d"日"';
    ed.font = { name: FONT, size: 10 };
    ed.alignment = { horizontal: 'center', vertical: 'middle' };
    ed.fill = solid(GRAY.head);
  });

  // 罫線。日の変わり目だけ太くして、どこまでが同じ日か分かるようにする。
  const LASTROW = FIRST + Math.max(rows.length, 1) - 1;
  for (let r = HEAD; r <= LASTROW; r++) {
    for (let c = 2; c <= LAST; c++) {
      const dayStart = c >= DAY0 && c < DAY0 + 14 && (c - DAY0) % 2 === 0;
      ws.getCell(r, c).border = {
        top: thin, bottom: thin,
        left: (dayStart || c === DAY0 + 14) ? med : thin,
        right: c === LAST ? med : thin,
      };
    }
  }

  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: HEAD + 2 }];

  const buf = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(buf as ArrayBuffer),
    filename: `入浴管理表_${weekStart}.xlsx`,
    weekStart,
    count: rows.length,
  };
}
