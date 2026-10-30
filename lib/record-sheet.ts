// 予約から「ショートステイ 記録表①／②」を作る。
//
// ⚠️ 記録表はユニットごとに使うので、1枚の表裏が「同じユニットの連続した2日」になるように並べる
//    （2026-10-30 現場の指定。以前は表＝さくら・裏＝すみれ の同じ日だった）。
//    選んだ日と翌日の2日ぶんを、さくら1日目 → さくら2日目 → すみれ1日目 → すみれ2日目 の順に
//    1ページずつ積む。両面印刷すると、さくら1枚・すみれ1枚 に分かれる。
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
import { MED_INTERNAL, MED_EYE, MED_COL, parseMeds, type MedKey } from './meds';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n: number) => String(n).padStart(2, '0');

interface Template {
  rows: number; cols: number;
  rowHeights: Record<string, number>;
  colWidths: Record<string, number>;
  defaultRowHeight?: number;
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
    dayUnit: 0,                                        // ①は「日」のセルがひな形にある
    roomBreak: false,                                  // ①は棟名と番号の間に全角空きがある
    roomRows: [5, 8, 11, 14, 17, 20, 23, 26, 29, 32],
    colRoom: 2, colName: 3, colVisit: 33,              // B / C / AG
    meds: true,                                        // 服薬管理欄（Z〜AF）がある
  },
  '2': {
    tpl: rec2 as unknown as Template,
    label: '記録表②',
    // ⚠️ ②のひな形には「日」のセルが無い（K年 M月数字 N月 O日数字 P曜日）。
    //    表示形式で「22日」と出すと列が狭くて ### になるので、P に「日」を入れて
    //    曜日を Q へ1つずらす。①と同じ並びになる。
    date: { year: 11, month: 13, day: 15, dow: 17 },   // K / M / O / Q（ずらしたあと）
    dayUnit: 16,                                       // P に「日」を足す
    // ⚠️ ②の居室名は「すみれ０１」と詰まっていて、列が狭いので折り返しで表示される。
    //    書体が ＭＳ Ｐゴシック（字幅がばらばら）なので、棟名によって折れる位置が変わり、
    //    さくらだと「さくら０／７」と割れてしまう。棟名のあとで必ず改行させる。
    roomBreak: true,
    roomRows: [5, 9, 13, 17, 21, 25, 29, 33, 37, 41],
    colRoom: 2, colName: 3, colVisit: 0,               // ②に来所帰所の欄は無い
    meds: false,
  },
} as const;

export type FormKey = keyof typeof FORMS;

/** ひな形のそのマスの見た目。無ければ空。 */
function tplStyle(t: Template, r: number, c: number) {
  const cl = t.cells.find(x => x.r === r && x.c === c);
  return cl?.s !== undefined ? t.styles[cl.s] : {};
}

interface Stay {
  name: string; start: string; end: string; inTime: string; outTime: string; key: string;
  soutaiIn: string; soutaiOut: string;   // 入所送迎／退所送迎（「家族送迎」なら FA）
}

/** ユニットの並びと、予約の一覧。1回だけ読んで、日ごとの在室は occupantsOn で拾う。 */
async function loadStays() {
  const data = await readSheets([SHEET.reserve, SHEET.rooms, SHEET.people]);
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
  const stays: Stay[] = [];
  for (const r of resRows.slice(1)) {
    const name = cell(r, ph.indexOf('氏名'));
    const start = cell(r, ph.indexOf('開始日'));
    const end = cell(r, ph.indexOf('終了日'));
    if (!name || !start || !end) continue;
    stays.push({
      name, start, end,
      soutaiIn: cell(r, ph.indexOf('入所送迎')),
      soutaiOut: cell(r, ph.indexOf('退所送迎')),
      inTime: cell(r, ph.indexOf('入所時間')),
      outTime: cell(r, ph.indexOf('退所時間')),
      key: `${cell(r, ph.indexOf('棟'))}-${Number(r[ph.indexOf('部屋')])}`,
    });
  }

  // 服薬管理（利用者シート）。氏名の空白の違いは無視して引けるようにしておく。
  const peopleRows = data[SHEET.people] ?? [];
  const uh = head(peopleRows);
  const meds = new Map<string, MedKey[]>();
  for (const r of peopleRows.slice(1)) {
    const m = parseMeds(cell(r, uh.indexOf('服薬管理')));
    if (m.length) meds.set(nameKey(cell(r, uh.indexOf('氏名'))), m);
  }
  return { units, stays, meds };
}

const nameKey = (s: string) => String(s ?? '').replace(/[\s　]+/g, '');

const MARK = '〇';
// 〇はマスいっぱいの大きさで（現場の指定）。マスは 幅 約42px × 高さ 30.75pt。
const MARK_FONT = { name: 'ＭＳ Ｐゴシック', size: 26 };
const black = (style: 'thin' | 'medium') => ({ style, color: { argb: 'FF000000' } }) as const;

/**
 * 記録表①の服薬管理欄に〇を付ける。tr はひな形での部屋の1行目（見出し「朝食前…眠前」の行）。
 *   2行目 … 内服。チェックした所（朝食前〜眠前）に〇
 *   3行目 … 点眼があるときだけ。Z に「点眼」、同じ行の 朝食後／昼食後／夕食後／眠前 の列に〇
 * ⚠️ ひな形の3行目は V（またはW）〜AF が1つにつながったセル。点眼のときだけ Z〜AF を切り離し、
 *    左の残り（〜Y）はつなぎ直す。
 */
function putMeds(ws: ExcelJS.Worksheet, t: Template, off: number, tr: number, meds: MedKey[]) {
  for (const k of MED_INTERNAL) {
    if (!meds.includes(k)) continue;
    const c = ws.getCell(off + tr + 1, MED_COL[k]);
    c.value = MARK;
    c.font = MARK_FONT;
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  const eye = MED_EYE.filter(k => meds.includes(k));
  if (!eye.length) return;
  const r = off + tr + 2;
  const band = t.merges.find(m => m[0] === tr + 2 && m[2] === tr + 2 && m[1] <= 26 && m[3] >= 32);
  if (band) {
    ws.unMergeCells(r, band[1], r, band[3]);
    if (band[1] < 25) ws.mergeCells(r, band[1], r, 25);
  }
  for (let c = 26; c <= 32; c++) {
    const cl = ws.getCell(r, c);
    cl.value = null;
    cl.font = { name: 'ＭＳ Ｐゴシック', size: 10 };
    cl.alignment = { horizontal: 'center', vertical: 'middle' };
    cl.border = { top: black('medium'), bottom: black('medium'), left: black('thin'), right: black(c === 32 ? 'medium' : 'thin') };
  }
  ws.getCell(r, 26).value = '点眼';
  for (const k of eye) {
    const cl = ws.getCell(r, MED_COL[k]);
    cl.value = MARK;
    cl.font = MARK_FONT;
  }
}

/** その日、どの部屋に誰がいるか。「棟-部屋番号」→ 予約。 */
function occupantsOn(stays: Stay[], day: string) {
  const by = new Map<string, Stay>();
  for (const s of stays) if (day >= s.start && day <= s.end) by.set(s.key, s);
  return by;
}

/** 翌日（YYYY-MM-DD）。 */
function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(y, m - 1, d + 1);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

/**
 * 時刻を分だけずらす（"HH:MM" のときだけ。午前／午後や空はそのまま返す）。
 * その日の 0:00〜23:59 からはみ出さないようにする。
 */
function shiftTime(t: string, delta: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim());
  if (!m) return t;
  const v = Math.min(23 * 60 + 59, Math.max(0, Number(m[1]) * 60 + Number(m[2]) + delta));
  return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`;
}

/**
 * 来所・帰所の欄。入所日なら来所、退所日なら帰所。時刻が無ければ枠だけ。
 * 午前／午後しか決まっていないときは「来所午前」のようにそのまま出す。
 *
 * ⚠️ 時刻の書き方（2026-10-30 現場の指定）
 *    ・家族送迎（FA）は予約の時刻そのままで、頭に FA を付ける
 *    ・それ以外は 来所＝予約の時刻＋15分／帰所＝予約の時刻−15分
 */
function visitLabel(day: string, o?: Stay): string {
  if (!o) return '';
  const parts: string[] = [];
  const one = (label: string, time: string, soutai: string, delta: number) => {
    if (!time) return `${label}　　:`;
    return soutai === '家族送迎' ? `${label}FA ${time}` : `${label}${shiftTime(time, delta)}`;
  };
  if (day === o.start) parts.push(one('来所', o.inTime, o.soutaiIn, +15));
  if (day === o.end) parts.push(one('帰所', o.outTime, o.soutaiOut, -15));
  return parts.join(' ');
}

export interface RecordSheet { buffer: Buffer; filename: string; day: string; filled: number; }

/** 日付を渡すと、その日と翌日の記録表（①か②）を、ユニットごとに表裏になる順で組み立てて返す。 */
export async function buildRecordSheet(day: string, form: FormKey): Promise<RecordSheet> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日付は YYYY-MM-DD で渡してください');
  const f = FORMS[form];
  const t = f.tpl;
  const [y, m, d] = day.split('-').map(Number);
  const day2 = nextDay(day);
  const [, m2, d2] = day2.split('-').map(Number);
  const { units, stays, meds } = await loadStays();
  // 1ページ＝1ユニット×1日。ユニットの中で日付を並べる（表＝1日目、裏＝2日目）。
  const pages = units.flatMap(unit => [day, day2].map(pd => ({ unit, day: pd })));

  // ⚠️ 印刷は見本のまま（等倍）。「ページに合わせる」を付けると縮んで行が低くなり、
  //    1ページずつきれいに分かれなくなる。
  const pageSetup: any = {
    orientation: t.page.orientation,
    paperSize: t.page.paperSize,
    margins: t.page.margins,
  };
  if (t.page.fitToPage) {
    pageSetup.fitToPage = true;
    if (t.page.fitToWidth != null) pageSetup.fitToWidth = t.page.fitToWidth;
    if (t.page.fitToHeight != null) pageSetup.fitToHeight = t.page.fitToHeight;
  } else if (t.page.scale) {
    pageSetup.scale = t.page.scale;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'グラン悠遊 ショート予約台帳';
  const ws = wb.addWorksheet(`${m}月${d}日・${m2}月${d2}日`, { pageSetup });

  if (t.defaultRowHeight) ws.properties.defaultRowHeight = t.defaultRowHeight;
  for (const [c, w] of Object.entries(t.colWidths)) ws.getColumn(Number(c)).width = w;

  let filled = 0;
  pages.forEach(({ unit, day: pd }, pi) => {
    const off = pi * t.rows;                       // 1ページずつ下へ積む
    const [py, pm, pdd] = pd.split('-').map(Number);
    const dow = WD[new Date(py, pm - 1, pdd).getDay()];
    const by = occupantsOn(stays, pd);

    for (const [r, h] of Object.entries(t.rowHeights)) ws.getRow(off + Number(r)).height = h;

    for (const cl of t.cells) {
      const cell = ws.getCell(off + cl.r, cl.c);
      if (cl.v !== undefined) cell.value = cl.v as any;
      if (cl.s !== undefined) cell.style = { ...(t.styles[cl.s] as any) };
    }
    for (const [r1, c1, r2, c2] of t.merges) ws.mergeCells(off + r1, c1, off + r2, c2);

    // 日付
    ws.getCell(off + 1, f.date.year).value = `${py}年`;
    ws.getCell(off + 1, f.date.month).value = pm;
    ws.getCell(off + 1, f.date.day).value = pdd;
    if (f.dayUnit) {
      // 「日」はひな形の「月」と同じ見た目、曜日はひな形の曜日セルの見た目を引き継ぐ
      const u = ws.getCell(off + 1, f.dayUnit);
      u.value = '日';
      u.style = { ...(tplStyle(t, 1, f.date.month + 1) as any) };
      const w = ws.getCell(off + 1, f.date.dow);
      w.style = { ...(tplStyle(t, 1, f.dayUnit) as any) };
    }
    // 曜日の括弧は見本で全角と半角が混ざっていた（手作業の名残）。全角にそろえる。
    ws.getCell(off + 1, f.date.dow).value = `（${dow}）`;

    // 居室と利用者
    f.roomRows.forEach((tr, i) => {
      const no = i + 1;
      const r = off + tr;
      const tplRoom = String(t.cells.find(x => x.r === tr && x.c === f.colRoom)?.v ?? '');
      // ひな形の「すみれ　　０１」の棟名だけ入れ替える（空きの入り方をそのまま残すため）
      const rc = ws.getCell(r, f.colRoom);
      rc.value = f.roomBreak
        ? `${unit}\n${(tplRoom.match(/[０-９]+$/) ?? [''])[0]}`
        : tplRoom.replace(/^[^\s０-９]+/, unit);
      if (f.roomBreak) rc.alignment = { ...(rc.alignment ?? {}), wrapText: true };
      const o = by.get(`${unit}-${no}`);
      ws.getCell(r, f.colName).value = o ? o.name : null;
      if (o) filled++;
      if (f.meds) {
        // ひな形の3行目に見本の書き込み（「点眼：朝(　　)」）が残っているので消しておく
        const band = t.merges.find(m => m[0] === tr + 2 && m[2] === tr + 2 && m[3] >= 32);
        if (band) ws.getCell(off + tr + 2, band[1]).value = null;
        const m = o ? meds.get(nameKey(o.name)) : undefined;
        if (m) putMeds(ws, t, off, tr, m);
      }
      if (f.colVisit) {
        const vc = ws.getCell(r, f.colVisit);
        vc.value = visitLabel(pd, o) || null;
        // ひな形は中央寄せと左寄せが混ざっていたので、すべて中央にそろえる（現場の指定）
        vc.alignment = { ...(vc.alignment ?? {}), horizontal: 'center', vertical: 'middle', wrapText: true };
      }
    });

    // 1ページずつ改ページ。両面印刷で、同じユニットの1日目と2日目が表裏になる。
    if (pi < pages.length - 1) ws.getRow(off + t.rows).addPageBreak();
  });

  const buf = await wb.xlsx.writeBuffer();
  const tail = m2 === m ? pad2(d2) : `${pad2(m2)}-${pad2(d2)}`;
  return {
    buffer: Buffer.from(buf as ArrayBuffer),
    filename: `${f.label}_${y}-${pad2(m)}-${pad2(d)}〜${tail}.xlsx`,
    day, filled,
  };
}
