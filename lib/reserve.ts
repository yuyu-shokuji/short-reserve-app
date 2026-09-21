// ショート予約台帳
//
// ■ なぜ月シートと別に持つか
// 食事データは「月ごとに別スプレッドシート」で、翌月シートは人が手で作る。
// 一方、予約は「来月・再来月ぶんを今入れる」のが当たり前で噛み合わない。
// そこで予約は、月に依存しない台帳（設定スプレッドシートの「ショート予約」シート）に
// 1予約=1行で持ち、確定したものを画面の「この月へ書き出す」でその月の ショート_記録 へ流す。
//
// ■ どちらが正か
// 予約台帳が正。ただし書き出し後の ショート_記録 は現場が入力アプリで直接直すので、
// 書き出しは「上書きしにいく」のではなく「空いているところへ書く」だけにしてある
// （先客がいる日は、とばすか上書きかを都度たずねる）。
// 台帳を直しても、もう一度書き出すまで月シートは変わらない。
//
// ■ 列の持ち方
// 引き継ぎ資料の教訓（ショート_名 の列10衝突）に従い、列番号のべた書きはせず
// すべて見出し名で列を探す。無い見出しは右端に作る。手で足した列は消さない。

import {
  CONFIG_SPREADSHEET_ID, readSheets, writeSheetAoa, ensureSheetExists,
  batchWrite, resolveSpreadsheetId, type CellWrite, type CellClear,
} from './sheets';
import { shortMealCol, findShortRow, SHORT_ROOMS } from './short-sheet';

const RESERVE_SHEET = 'ショート予約';

/** 台帳の列（見出し名で探す。順番はシートを人が見たときの読みやすさ） */
const COLS = ['ID', '氏名', '棟', '部屋', '開始日', '終了日', '状態', '備考', '登録日時', '書出日時'] as const;

export type ReserveStatus = '仮予約' | '確定';

export interface ShortReservation {
  id: string;
  name: string;
  building: string;   // さくら / すみれ
  room: number;       // 1〜10
  start: string;      // YYYY-MM-DD（初日＝入所日）
  end: string;        // YYYY-MM-DD（最終日＝退所日）
  status: ReserveStatus;
  note: string;
  createdAt: string;
  exportedAt: string;  // 最後に月シートへ書き出した日時（空＝未書出）
  rowIdx: number;      // 台帳シート上の行（0始まり・内部用）
}

// ── 日付ヘルパー（すべて YYYY-MM-DD のローカル日付として扱う） ───────────

const pad2 = (n: number) => String(n).padStart(2, '0');

export function isoOf(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 'YYYY-MM-DD' → {y,m,d}。形式が違えば null。 */
export function parseISO(s: string): { y: number; m: number; d: number } | null {
  const mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s ?? '').trim());
  if (!mm) return null;
  const y = Number(mm[1]), m = Number(mm[2]), d = Number(mm[3]);
  if (m < 1 || m > 12 || d < 1 || d > new Date(y, m, 0).getDate()) return null;
  return { y, m, d };
}

/** 開始〜終了（両端を含む）の日付を並べる。長すぎる指定は安全のため打ち切る。 */
export function eachDate(startISO: string, endISO: string): string[] {
  const s = parseISO(startISO), e = parseISO(endISO);
  if (!s || !e) return [];
  const out: string[] = [];
  const cur = new Date(s.y, s.m - 1, s.d);
  const last = new Date(e.y, e.m - 1, e.d);
  while (cur <= last && out.length < 400) {
    out.push(isoOf(cur.getFullYear(), cur.getMonth() + 1, cur.getDate()));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function nowStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ── 台帳シートの読み書き ─────────────────────────────────────────────

interface Grid { rows: any[][]; col: Record<string, number>; headWidth: number; }

/**
 * 台帳シートを読む。無ければ作る。
 * col は見出し名→列番号。見出しが無い列は右端に割り当て、保存時に見出しごと書く。
 */
async function loadGrid(): Promise<Grid> {
  let rows: any[][];
  try {
    rows = (await readSheets([RESERVE_SHEET], CONFIG_SPREADSHEET_ID))[RESERVE_SHEET] ?? [];
  } catch {
    await ensureSheetExists(RESERVE_SHEET, [...COLS], CONFIG_SPREADSHEET_ID);
    rows = (await readSheets([RESERVE_SHEET], CONFIG_SPREADSHEET_ID))[RESERVE_SHEET] ?? [];
  }
  if (!rows.length) rows = [[...COLS]];
  const head = rows[0] ?? [];
  const headWidth = rows.reduce((m, r) => Math.max(m, r.length), head.length);
  let next = headWidth;
  const col: Record<string, number> = {};
  for (const k of COLS) {
    const i = head.findIndex((c: any) => String(c ?? '').trim() === k);
    col[k] = i >= 0 ? i : next++;
  }
  return { rows, col, headWidth };
}

function cell(row: any[] | undefined, c: number): string {
  return String(row?.[c] ?? '').trim();
}

function parseRow(row: any[], col: Record<string, number>, rowIdx: number): ShortReservation | null {
  const name  = cell(row, col['氏名']);
  const start = cell(row, col['開始日']);
  const end   = cell(row, col['終了日']);
  if (!name || !parseISO(start) || !parseISO(end)) return null;
  const st = cell(row, col['状態']);
  return {
    // 手で足された行（IDなし）も拾えるよう、無ければ行番号から作る
    id: cell(row, col['ID']) || `#${rowIdx}`,
    name,
    building: cell(row, col['棟']),
    room: Number(cell(row, col['部屋'])) || 0,
    start, end,
    status: st === '確定' ? '確定' : '仮予約',
    note: cell(row, col['備考']),
    createdAt: cell(row, col['登録日時']),
    exportedAt: cell(row, col['書出日時']),
    rowIdx,
  };
}

/** 台帳の全予約。開始日→棟→部屋の順。 */
export async function listReservations(): Promise<ShortReservation[]> {
  const { rows, col } = await loadGrid();
  const out: ShortReservation[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = parseRow(rows[i], col, i);
    if (r) out.push(r);
  }
  return out.sort((a, b) =>
    a.start.localeCompare(b.start) || a.building.localeCompare(b.building, 'ja') || a.room - b.room);
}

/** 指定した年月にかかる予約だけ返す（月またぎの滞在も含む）。 */
export async function listReservationsForMonth(year: number, month: number): Promise<ShortReservation[]> {
  const monthStart = isoOf(year, month, 1);
  const monthEnd   = isoOf(year, month, new Date(year, month, 0).getDate());
  const all = await listReservations();
  return all.filter(r => r.start <= monthEnd && r.end >= monthStart);
}

// ── 重なりチェック ───────────────────────────────────────────────────

export interface ReserveConflict {
  kind: 'room' | 'person';
  other: ShortReservation;
  days: string[];
}

function overlapDays(a: ShortReservation, bStart: string, bEnd: string): string[] {
  const s = a.start > bStart ? a.start : bStart;
  const e = a.end   < bEnd   ? a.end   : bEnd;
  return s <= e ? eachDate(s, e) : [];
}

/**
 * 予約の重なりを調べる。
 *  room  … 同じ部屋が同じ日に二重予約
 *  person… 同じ人が同じ日に別の部屋（＝入力ミスの可能性が高い）
 * 仮予約どうし・仮予約と確定のどちらも重なりとして返し、判断は画面に任せる。
 */
export async function findReserveConflicts(
  cand: { id?: string; name: string; building: string; room: number; start: string; end: string },
): Promise<ReserveConflict[]> {
  const all = await listReservations();
  const out: ReserveConflict[] = [];
  for (const r of all) {
    if (cand.id && r.id === cand.id) continue;
    const days = overlapDays(r, cand.start, cand.end);
    if (!days.length) continue;
    if (r.building === cand.building && r.room === cand.room) out.push({ kind: 'room', other: r, days });
    else if (r.name === cand.name.trim()) out.push({ kind: 'person', other: r, days });
  }
  return out;
}

// ── 追加・更新・削除 ─────────────────────────────────────────────────

export interface SaveReservationParams {
  id?: string;         // 省略＝新規
  name: string;
  building: string;
  room: number;
  start: string;
  end: string;
  status: ReserveStatus;
  note?: string;
}

function validate(p: SaveReservationParams): void {
  if (!p.name?.trim()) throw new Error('氏名を入力してください');
  if (p.building !== 'さくら' && p.building !== 'すみれ') throw new Error('棟が不正です');
  if (!SHORT_ROOMS.some(r => r.building === p.building && r.room === Number(p.room))) {
    throw new Error(`${p.building}${p.room}号 は存在しません`);
  }
  if (!parseISO(p.start)) throw new Error('開始日が不正です');
  if (!parseISO(p.end))   throw new Error('終了日が不正です');
  if (p.end < p.start)    throw new Error('終了日が開始日より前になっています');
  if (eachDate(p.start, p.end).length > 200) throw new Error('期間が長すぎます（200日まで）');
}

/**
 * 予約を追加（id なし）または更新（id あり）する。1回の batchWrite で書く。
 * 戻り値は保存後のID。
 */
export async function saveReservation(p: SaveReservationParams): Promise<string> {
  validate(p);
  const { rows, col, headWidth } = await loadGrid();

  // 更新先の行を決める。'#n' は手で足されたID無し行（行番号で指す）。
  let rowIdx = -1;
  if (p.id) {
    if (p.id.startsWith('#')) {
      const n = Number(p.id.slice(1));
      if (Number.isInteger(n) && n >= 1 && n < rows.length) rowIdx = n;
    } else {
      rowIdx = rows.findIndex((r, i) => i >= 1 && cell(r, col['ID']) === p.id);
    }
    if (rowIdx < 1) throw new Error('この予約は見つかりませんでした（他の人が消した可能性があります）');
  } else {
    rowIdx = rows.length;   // 末尾に追加
  }

  const id = (p.id && !p.id.startsWith('#')) ? p.id
    : `R${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

  const writes: CellWrite[] = [];
  const clears: CellClear[] = [];
  const put = (key: string, value: string | number) => {
    const c = col[key];
    if (value === '' || value == null) clears.push({ sheet: RESERVE_SHEET, row: rowIdx, col: c });
    else writes.push({ sheet: RESERVE_SHEET, row: rowIdx, col: c, value });
    // 見出しが無くて右端に作った列は、見出しも一緒に書く
    if (c >= headWidth) writes.push({ sheet: RESERVE_SHEET, row: 0, col: c, value: key });
  };

  put('ID', id);
  put('氏名', p.name.trim());
  put('棟', p.building);
  put('部屋', Number(p.room));
  put('開始日', p.start);
  put('終了日', p.end);
  put('状態', p.status === '確定' ? '確定' : '仮予約');
  put('備考', (p.note ?? '').trim());
  if (!p.id) put('登録日時', nowStamp());
  // 内容が変わったので「書き出し済み」は消す（もう一度書き出すまで月シートは古いまま）
  put('書出日時', '');

  await batchWrite(writes, clears, CONFIG_SPREADSHEET_ID);
  return id;
}

/** 予約を1件削除（行ごと削除）。月シートに書き出し済みのぶんは消えないので画面で知らせる。 */
export async function deleteReservation(id: string): Promise<ShortReservation> {
  const { rows, col } = await loadGrid();
  let rowIdx = -1;
  if (id.startsWith('#')) {
    const n = Number(id.slice(1));
    if (Number.isInteger(n) && n >= 1 && n < rows.length) rowIdx = n;
  } else {
    rowIdx = rows.findIndex((r, i) => i >= 1 && cell(r, col['ID']) === id);
  }
  if (rowIdx < 1) throw new Error('この予約は見つかりませんでした');

  const removed = parseRow(rows[rowIdx], col, rowIdx);
  if (!removed) throw new Error('この予約は見つかりませんでした');
  const grid = rows.map(r => r.map((c: any) => (c === '' ? null : c)));
  grid.splice(rowIdx, 1);
  await writeSheetAoa(RESERVE_SHEET, grid, CONFIG_SPREADSHEET_ID);
  return removed;
}

// ── 月シート（ショート_記録）への書き出し ─────────────────────────────

// 食事の入り方は入力アプリの「カレンダーから入力」と同じ既定値に揃える。
//  単日      … 昼・おやつ（昼から昼まで）
//  入所日    … 朝なし（昼・おやつ・夕）
//  退所日    … 夕なし（朝・昼・おやつ）
//  中日      … 三食
// ※ 月をまたぐ滞在でも「入所日／退所日」は予約全体の端で判定する。
//    例）9/28〜10/3 なら 9/30 は中日＝三食、10/1 も中日＝三食。
function mealsForDay(iso: string, r: ShortReservation): [boolean, boolean, boolean, boolean] {
  if (r.start === r.end)  return [false, true, true, false];
  if (iso === r.start)    return [false, true, true, true];
  if (iso === r.end)      return [true, true, true, false];
  return [true, true, true, true];
}

export interface ExportConflict {
  date: string; building: string; room: number;
  existing: string;   // 月シートに既に入っている人
  reserved: string;   // 書き出そうとした人
}

export interface ExportPreviewItem {
  id: string; name: string; building: string; room: number;
  from: string; to: string; days: number;
}

export interface ExportResult {
  conflict?: true;
  conflicts?: ExportConflict[];
  ok?: true;
  items?: ExportPreviewItem[];
  days?: number;         // 書き込んだ延べ日数
  skipped?: number;      // 先客がいて書かなかった延べ日数
}

/** 先客がいる日の扱い。未指定＝先客が1日でもあれば何も書かずに知らせる。 */
export type ExportMode = 'skip' | 'overwrite';

/**
 * 指定月の「確定」予約を、その月の ショート_記録 へ書き出す。
 * 先客（別人の氏名・食事）がいる日があれば、mode 未指定のうちは何も書かずに返す。
 *   skip      … 先客の日はとばして、残りだけ書く（月シート側の修正を尊重する）
 *   overwrite … 先客ごと上書きする
 * 書き込みは1回の batchWrite にまとめる（個別APIのループはクォータ超過＆激遅）。
 */
export async function exportReservationsToMonth(
  year: number, month: number, opts?: { mode?: ExportMode; ids?: string[] },
): Promise<ExportResult> {
  let sid: string;
  try {
    sid = await resolveSpreadsheetId(year, month);
  } catch {
    throw new Error(`${year}年${month}月のスプレッドシートがまだありません。入力アプリの設定タブ「翌月の準備」で作ってから書き出してください`);
  }

  const monthStart = isoOf(year, month, 1);
  const monthEnd   = isoOf(year, month, new Date(year, month, 0).getDate());
  const idSet = opts?.ids?.length ? new Set(opts.ids) : null;
  const targets = (await listReservations()).filter(r =>
    r.status === '確定' && r.start <= monthEnd && r.end >= monthStart && (!idSet || idSet.has(r.id)));

  if (!targets.length) return { ok: true, items: [], days: 0, skipped: 0 };

  const rows = (await readSheets(['ショート_記録'], sid))['ショート_記録'] ?? [];

  // ── 1周目：書き出す日を決め、先客がいる日を洗い出す（まだ書かない） ──
  interface Plan { r: ShortReservation; rowIdx: number; days: { iso: string; blocked: boolean }[]; }
  const plans: Plan[] = [];
  const conflicts: ExportConflict[] = [];

  for (const r of targets) {
    const rowIdx = findShortRow(rows, r.building, r.room);
    if (rowIdx === -1) throw new Error(`${r.building}${r.room}号 が ${year}年${month}月のシートに見つかりません`);
    const sheetRow = rows[rowIdx] ?? [];

    const inMonth = eachDate(r.start, r.end).filter(d => d >= monthStart && d <= monthEnd);
    if (!inMonth.length) continue;

    const days = inMonth.map(iso => {
      const d = parseISO(iso)!.d;
      // 先客＝その日のその部屋に入っている「別人」。氏名列と食事列（同日交代）の両方を見る。
      const found = new Set<string>();
      const occ = String(sheetRow[shortMealCol(d, 0)] ?? '').trim();
      if (occ && occ !== r.name) found.add(occ);
      for (const m of [1, 2, 3, 4]) {
        const v = String(sheetRow[shortMealCol(d, m)] ?? '').trim();
        if (v && v !== '1' && v !== r.name) found.add(v);
      }
      for (const existing of found) {
        conflicts.push({ date: iso, building: r.building, room: r.room, existing, reserved: r.name });
      }
      return { iso, blocked: found.size > 0 };
    });
    plans.push({ r, rowIdx, days });
  }

  if (conflicts.length && !opts?.mode) return { conflict: true, conflicts };

  // ── 2周目：実際に書くセルを組む（skip なら先客の日はとばす） ──
  const skipBlocked = opts?.mode === 'skip';
  const writes: CellWrite[] = [];
  const clears: CellClear[] = [];
  const items: ExportPreviewItem[] = [];
  let dayCount = 0, skipped = 0;

  for (const { r, rowIdx, days } of plans) {
    const written: string[] = [];
    for (const { iso, blocked } of days) {
      if (blocked && skipBlocked) { skipped++; continue; }
      const d = parseISO(iso)!.d;
      const meals = mealsForDay(iso, r);
      writes.push({ sheet: 'ショート_記録', row: rowIdx, col: shortMealCol(d, 0), value: r.name });
      for (let mi = 0; mi < 4; mi++) {
        const col = shortMealCol(d, mi + 1);
        if (meals[mi]) writes.push({ sheet: 'ショート_記録', row: rowIdx, col, value: 1 });
        else clears.push({ sheet: 'ショート_記録', row: rowIdx, col });
      }
      written.push(iso);
      dayCount++;
    }
    if (written.length) {
      items.push({
        id: r.id, name: r.name, building: r.building, room: r.room,
        from: written[0], to: written[written.length - 1], days: written.length,
      });
    }
  }

  if (!writes.length && !clears.length) return { ok: true, items: [], days: 0, skipped };

  await batchWrite(writes, clears, sid);

  // 書き出せたぶんに書出日時を立てる（1回の batchWrite）
  const stamp = nowStamp();
  const { rows: gRows, col, headWidth } = await loadGrid();
  const stampWrites: CellWrite[] = [];
  const doneIds = new Set(items.map(i => i.id));
  for (let i = 1; i < gRows.length; i++) {
    const id = cell(gRows[i], col['ID']) || `#${i}`;
    if (doneIds.has(id)) stampWrites.push({ sheet: RESERVE_SHEET, row: i, col: col['書出日時'], value: stamp });
  }
  if (col['書出日時'] >= headWidth) {
    stampWrites.push({ sheet: RESERVE_SHEET, row: 0, col: col['書出日時'], value: '書出日時' });
  }
  if (stampWrites.length) await batchWrite(stampWrites, [], CONFIG_SPREADSHEET_ID);

  return { ok: true, items, days: dayCount, skipped };
}
