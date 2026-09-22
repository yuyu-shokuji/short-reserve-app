// 予約台帳から「入浴・洗濯管理表」を1週間ぶん作る（試作）。
//
//   node scripts/make-bath-sheet.mjs --week=2026-09-20
//   node scripts/make-bath-sheet.mjs --week=2026-09-20 --id=<スプレッドシートID> --out=<フォルダ>
//
// --week は日曜日を渡す。日曜以外を渡したときは、その週の日曜まで戻して作る。
// 出す先は週ごとに1ファイル（既定は short-reserve-app/out/）。
//
// いまの紙（ネオライフサポート ショートステイ 入浴・洗濯管理表）に合わせているが、
// 入浴欄・洗濯欄は2セルではなく1セルにしてある（1週14列＋見出しで17列）。
//
// ⚠️ 将来この処理はアプリ側（ブラウザで押したら落ちてくる）に移す前提なので、
//    Excelの組み立ては exceljs で書いてある。Pythonに移し替えないこと。
import ExcelJS from 'exceljs';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');
const arg = (n) => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? '').split('=')[1] ?? '';
const ID = arg('id') || process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';
const OUT_DIR = arg('out') || path.join(__dirname, '..', 'out');

// ── 週（日曜〜土曜） ─────────────────────────────────────
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const weekArg = arg('week');
if (!/^\d{4}-\d{2}-\d{2}$/.test(weekArg)) {
  console.log('週の日曜日を --week=2026-09-20 の形で渡してください');
  process.exit(1);
}
const [wy, wm, wd] = weekArg.split('-').map(Number);
const sunday = new Date(wy, wm - 1, wd);
if (sunday.getDay() !== 0) {
  sunday.setDate(sunday.getDate() - sunday.getDay());
  console.log(`※ ${weekArg} は${WD[new Date(wy, wm - 1, wd).getDay()]}曜なので、その週の日曜 ${iso(sunday)} から作ります`);
}
const days = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(sunday); d.setDate(d.getDate() + i); return d;
});
const weekStart = iso(days[0]), weekEnd = iso(days[6]);

// ── 予約を読む ──────────────────────────────────────────
const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
const sheets = google.sheets({ version: 'v4', auth });
const got = await sheets.spreadsheets.values.batchGet({
  spreadsheetId: ID, ranges: [`'予約'`, `'部屋'`], valueRenderOption: 'UNFORMATTED_VALUE',
});
const [resRows, roomRows] = (got.data.valueRanges ?? []).map(v => v.values ?? []);

const cols = (rows) => {
  const h = (rows[0] ?? []).map(c => String(c ?? '').trim());
  return (name) => h.indexOf(name);
};
const cell = (r, i) => String(r?.[i] ?? '').trim();

// 部屋シートの並び順をそのまま行の並びに使う（棟の順も部屋番号の順もシートが正）
const rc = cols(roomRows);
const roomOrder = new Map();       // "棟-部屋" → 並び順
const buildingOrder = new Map();   // 棟 → 並び順
roomRows.slice(1).forEach((r, i) => {
  const b = cell(r, rc('棟')), no = Number(r[rc('部屋')]);
  if (!b || !no) return;
  if (cell(r, rc('仮置き'))) return;                 // 仮置きは実在しないので出さない
  if (!buildingOrder.has(b)) buildingOrder.set(b, buildingOrder.size);
  roomOrder.set(`${b}-${no}`, i);
});

const pc = cols(resRows);
const rows = resRows.slice(1)
  .map(r => ({
    name: cell(r, pc('氏名')),
    building: cell(r, pc('棟')),
    room: Number(r[pc('部屋')]),
    start: cell(r, pc('開始日')),
    end: cell(r, pc('終了日')),
    status: cell(r, pc('状態')),
  }))
  .filter(r => r.name && r.start && r.end)
  .filter(r => r.start <= weekEnd && r.end >= weekStart)     // その週にかかる予約だけ
  .filter(r => roomOrder.has(`${r.building}-${r.room}`))     // 仮置きを除く
  // 同じ人でも部屋が変われば別の行。並びは 棟 → 部屋番号 → 開始日。
  .sort((a, b) =>
    (buildingOrder.get(a.building) ?? 99) - (buildingOrder.get(b.building) ?? 99)
    || a.room - b.room
    || a.start.localeCompare(b.start));

console.log(`${weekStart}（日）〜${weekEnd}（土）　${rows.length}件`);

// ── 体裁 ────────────────────────────────────────────────
const FONT = 'Yu Gothic';
const GRAY = { head: 'FFD9D9D9', bathHead: 'FFBFBFBF', bath: 'FFA6A6A6', wash: 'FFD9D9D9' };
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FF808080' } };
const med = { style: 'medium', color: { argb: 'FF404040' } };

const wb = new ExcelJS.Workbook();
wb.creator = 'グラン悠遊 ショート予約台帳';
const ws = wb.addWorksheet(`${weekStart}`, {
  pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
});

// A=余白 / B=ユニット / C=氏名 / D〜Q=7日×2列 / R=期間
const DAY0 = 4;                                   // D列
const colOf = (dayIdx, kind) => DAY0 + dayIdx * 2 + (kind === 'wash' ? 1 : 0);
const LAST = colOf(6, 'wash') + 1;                // R列＝期間
ws.getColumn(1).width = 2.5;
ws.getColumn(2).width = 7.5;
ws.getColumn(3).width = 18;
for (let d = 0; d < 7; d++) { ws.getColumn(colOf(d, 'bath')).width = 5; ws.getColumn(colOf(d, 'wash')).width = 5; }
ws.getColumn(LAST).width = 10;

const L = (n) => ws.getColumn(n).letter;

// 表題
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

// 見出し（4行目＝日付 / 5行目＝曜日 / 6行目＝入浴・洗濯）
const HEAD = 4;
const headCell = (r, c, v, fill) => {
  const cl = ws.getCell(r, c);
  cl.value = v;
  cl.font = { name: FONT, size: 10, bold: true };
  cl.alignment = { horizontal: 'center', vertical: 'middle' };
  cl.fill = solid(fill);
  cl.border = { top: thin, bottom: thin, left: thin, right: thin };
  return cl;
};
ws.mergeCells(HEAD, 2, HEAD + 2, 2); headCell(HEAD, 2, 'ユニット', GRAY.head);
ws.mergeCells(HEAD, 3, HEAD + 2, 3); headCell(HEAD, 3, '利用者名', GRAY.head);
ws.mergeCells(HEAD, LAST, HEAD + 2, LAST); headCell(HEAD, LAST, '期間', GRAY.head);
for (let d = 0; d < 7; d++) {
  const c0 = colOf(d, 'bath'), c1 = colOf(d, 'wash');
  ws.mergeCells(HEAD, c0, HEAD, c1);
  headCell(HEAD, c0, `${days[d].getMonth() + 1}/${days[d].getDate()}`, GRAY.head);
  ws.mergeCells(HEAD + 1, c0, HEAD + 1, c1);
  headCell(HEAD + 1, c0, WD[d], GRAY.head);
  headCell(HEAD + 2, c0, '入浴', GRAY.bathHead);
  headCell(HEAD + 2, c1, '洗濯', GRAY.head);
}
ws.getRow(HEAD).height = 18;
ws.getRow(HEAD + 1).height = 16;
ws.getRow(HEAD + 2).height = 16;

// 明細
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

  for (let d = 0; d < 7; d++) {
    const day = iso(days[d]);
    const staying = day >= rv.start && day <= rv.end;
    for (const kind of ['bath', 'wash']) {
      const c = ws.getCell(r, colOf(d, kind));
      c.font = { name: FONT, size: 12 };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      if (staying) c.fill = solid(kind === 'bath' ? GRAY.bath : GRAY.wash);
    }
  }

  // 期間＝滞在予定の最終日
  const ed = ws.getCell(r, LAST);
  const [ey, em, edd] = rv.end.split('-').map(Number);
  // ⚠️ exceljs は Date を UTC として書く。ここで地元時間の Date を渡すと
  //    日本時間ぶん巻き戻って1日前になる。必ず Date.UTC で作ること。
  ed.value = new Date(Date.UTC(ey, em - 1, edd));
  ed.numFmt = 'm"月"d"日"';
  ed.font = { name: FONT, size: 10 };
  ed.alignment = { horizontal: 'center', vertical: 'middle' };
  ed.fill = solid(GRAY.head);
});

// 罫線（日ごとの区切りだけ太く）
const LASTROW = FIRST + Math.max(rows.length, 1) - 1;
for (let r = HEAD; r <= LASTROW; r++) {
  for (let c = 2; c <= LAST; c++) {
    const cl = ws.getCell(r, c);
    const dayStart = c >= DAY0 && c < DAY0 + 14 && (c - DAY0) % 2 === 0;
    cl.border = {
      top: thin, bottom: thin,
      left: (dayStart || c === DAY0 + 14) ? med : thin,
      right: c === LAST ? med : thin,
    };
  }
}

ws.views = [{ state: 'frozen', xSplit: 3, ySplit: HEAD + 2 }];

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `入浴管理表_${weekStart}.xlsx`);
await wb.xlsx.writeFile(out);
console.log(`できました: ${out}`);
rows.forEach(r => console.log(`   ${r.building}${pad2(r.room)}  ${r.name}　${r.start}〜${r.end}${r.status === '仮予約' ? '（仮）' : ''}`));
