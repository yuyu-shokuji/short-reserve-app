// 予約台帳のデータ操作（このアプリ単体で完結）。
//
// スプレッドシートは3シート：
//   予約   … 1予約=1行。この台帳が正。
//   利用者 … 氏名の候補（ふりがな順）。
//   部屋   … さくら/すみれの部屋。増減はシートを直せばよく、コードは触らなくていい。
//
// 列はすべて見出し名で探す（列番号のべた書きはしない）。見出しが無ければ右端に作る。
// 食事管理アプリの ショート_名 で「列10が非表示と衝突して人が消える」事故があったため。

import {
  readSheets, writeSheetAoa, batchWrite, ensureSheetExists, appendRow,
  SHEET, type CellWrite, type CellClear,
} from './sheets';

const COLS = ['ID', '氏名', '棟', '部屋', '開始日', '終了日', '状態', '送迎', '入所時間', '退所時間', '備考', '登録日時'] as const;

export type ReserveStatus = '仮予約' | '確定';

/** 送迎の区分。'' ＝なし。家族送迎は画面で「FA」と出す。 */
export type SoutaiKind = '' | '送迎あり' | '家族送迎';

export interface Reservation {
  id: string;
  name: string;
  building: string;
  room: number;
  start: string;       // YYYY-MM-DD（初日＝入所日）
  end: string;         // YYYY-MM-DD（最終日＝退所日）
  status: ReserveStatus;
  soutai: SoutaiKind;
  // 入退所の時間は送迎の有無と関係なく使う（送迎なしでも来所・帰宅の時間は要る）
  inTime: string;      // 入所時間（初日）
  outTime: string;     // 退所時間（最終日）
  note: string;
  createdAt: string;
  rowIdx: number;      // シート上の行（0始まり・内部用）
}

/** シートの表記ゆれを吸収する（'あり' など古い書き方も拾う） */
function parseSoutai(raw: string): SoutaiKind {
  const s = raw.trim();
  if (!s || s === 'なし') return '';
  if (s.includes('家族')) return '家族送迎';
  return '送迎あり';
}

export interface Room {
  building: string;
  room: number;
  disabled: boolean;
  /** 仮置き＝入れ替え作業の一時置き場。実在しないので空き部屋数にも空き検索にも数えない。 */
  staging: boolean;
  note: string;
}
export interface Person { name: string; furi: string; contact: string; note: string; }

// ── 日付ヘルパー（すべて YYYY-MM-DD のローカル日付として扱う） ───────────

const pad2 = (n: number) => String(n).padStart(2, '0');

export function isoOf(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

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

/** 期間が1日でも重なるか（両端を含む）。 */
function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

/** 重なっている日の一覧。 */
function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): string[] {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  return s <= e ? eachDate(s, e) : [];
}

/**
 * 同日交代かどうか。
 * 片方の退所日ともう片方の入所日が同じ日で、重なりがその1日だけなら
 * 「午前に出て午後に入る」ふつうの入れ替わりなので二重予約ではない。
 * 例：A が 10:00 に退所、B が 11:00 に入所。
 */
export function isHandover(
  aStart: string, aEnd: string, bStart: string, bEnd: string,
): boolean {
  const days = overlapDays(aStart, aEnd, bStart, bEnd);
  if (days.length !== 1) return false;
  const d = days[0];
  return (aEnd === d && bStart === d) || (bEnd === d && aStart === d);
}

// ── シートの読み込み ─────────────────────────────────────────────────

function cell(row: any[] | undefined, c: number): string {
  return String(row?.[c] ?? '').trim();
}

interface Grid { rows: any[][]; col: Record<string, number>; headWidth: number; }

function indexColumns(rows: any[][], keys: readonly string[]): Grid {
  const head = rows[0] ?? [];
  const headWidth = rows.reduce((m, r) => Math.max(m, r.length), head.length);
  let next = headWidth;
  const col: Record<string, number> = {};
  for (const k of keys) {
    const i = head.findIndex((c: any) => String(c ?? '').trim() === k);
    col[k] = i >= 0 ? i : next++;
  }
  return { rows, col, headWidth };
}

function parseRow(row: any[], col: Record<string, number>, rowIdx: number): Reservation | null {
  const name = cell(row, col['氏名']);
  const start = cell(row, col['開始日']);
  const end = cell(row, col['終了日']);
  if (!name || !parseISO(start) || !parseISO(end)) return null;
  return {
    // 手で足された行（IDなし）も拾えるよう、無ければ行番号から作る
    id: cell(row, col['ID']) || `#${rowIdx}`,
    name,
    building: cell(row, col['棟']),
    room: Number(cell(row, col['部屋'])) || 0,
    start, end,
    status: cell(row, col['状態']) === '確定' ? '確定' : '仮予約',
    soutai: parseSoutai(cell(row, col['送迎'])),
    inTime: cell(row, col['入所時間']),
    outTime: cell(row, col['退所時間']),
    note: cell(row, col['備考']),
    createdAt: cell(row, col['登録日時']),
    rowIdx,
  };
}

async function loadAll(): Promise<{ grid: Grid; reservations: Reservation[]; rooms: Room[]; people: Person[] }> {
  const s = await readSheets([SHEET.reserve, SHEET.people, SHEET.rooms]);
  const grid = indexColumns(s[SHEET.reserve] ?? [], COLS);

  const reservations: Reservation[] = [];
  for (let i = 1; i < grid.rows.length; i++) {
    const r = parseRow(grid.rows[i], grid.col, i);
    if (r) reservations.push(r);
  }
  reservations.sort((a, b) =>
    a.start.localeCompare(b.start) || a.building.localeCompare(b.building, 'ja') || a.room - b.room);

  const roomRows = s[SHEET.rooms] ?? [];
  const rc = indexColumns(roomRows, ['棟', '部屋', '使用しない', '仮置き', '備考']).col;
  const rooms: Room[] = roomRows.slice(1)
    .map(r => ({
      building: cell(r, rc['棟']),
      room: Number(cell(r, rc['部屋'])) || 0,
      disabled: cell(r, rc['使用しない']) !== '',
      staging: cell(r, rc['仮置き']) !== '',
      note: cell(r, rc['備考']),
    }))
    .filter(r => r.building && r.room);

  const peopleRows = s[SHEET.people] ?? [];
  const pc = indexColumns(peopleRows, ['氏名', 'ふりがな', '連絡先', '備考']).col;
  const people: Person[] = peopleRows.slice(1)
    .map(r => ({
      name: cell(r, pc['氏名']),
      furi: cell(r, pc['ふりがな']),
      contact: cell(r, pc['連絡先']),
      note: cell(r, pc['備考']),
    }))
    .filter(p => p.name);

  return { grid, reservations, rooms, people };
}

/** 部屋・利用者（画面の選択肢に使う）。 */
export async function getMaster(): Promise<{ rooms: Room[]; people: Person[] }> {
  const { rooms, people } = await loadAll();
  return { rooms, people };
}

/** 指定した年月にかかる予約（月またぎの滞在も含む）＋部屋一覧。 */
export async function getMonth(year: number, month: number): Promise<{
  year: number; month: number; daysInMonth: number;
  reservations: Reservation[]; rooms: Room[];
}> {
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart = isoOf(year, month, 1);
  const monthEnd = isoOf(year, month, daysInMonth);
  const { reservations, rooms } = await loadAll();
  return {
    year, month, daysInMonth, rooms,
    reservations: reservations.filter(r => overlaps(r.start, r.end, monthStart, monthEnd)),
  };
}

// ── 空き部屋の検索（「空き部屋を探すのが大変」への対策） ─────────────────

export interface Vacancy {
  building: string;
  room: number;
  free: boolean;
  /** 空いていない場合、ふさいでいる予約 */
  takenBy?: { name: string; start: string; end: string; status: ReserveStatus }[];
}

/**
 * 期間を丸ごと押さえられる部屋はどれか。
 * 1日でも重なっている予約があれば「空いていない」＝電話中にそのまま答えられるようにする。
 * excludeId を渡すと、その予約自身は無視する（期間変更のときに自分で自分をふさがないため）。
 */
export async function findVacancies(
  start: string, end: string, excludeId?: string,
): Promise<{ vacancies: Vacancy[]; freeCount: number }> {
  if (!parseISO(start) || !parseISO(end) || end < start) {
    throw new Error('期間が正しくありません');
  }
  const { reservations, rooms } = await loadAll();
  // 仮置きは実在する部屋ではないので「空いている部屋」に出さない
  const vacancies: Vacancy[] = rooms.filter(r => !r.disabled && !r.staging).map(r => {
    const takenBy = reservations
      .filter(x => x.id !== excludeId && x.building === r.building && x.room === r.room
        && overlaps(x.start, x.end, start, end)
        // 退所日と入所日が重なるだけの入れ替わりは「ふさがっている」に数えない
        && !isHandover(x.start, x.end, start, end))
      .map(x => ({ name: x.name, start: x.start, end: x.end, status: x.status }));
    return { building: r.building, room: r.room, free: takenBy.length === 0, takenBy: takenBy.length ? takenBy : undefined };
  });
  return { vacancies, freeCount: vacancies.filter(v => v.free).length };
}

// ── 重なりチェック ───────────────────────────────────────────────────

export interface Conflict {
  /** room = 同じ部屋の二重予約／person = 同じ人を同じ日に別の部屋へ（逆ダブルブッキング） */
  kind: 'room' | 'person';
  other: Reservation;
  days: string[];
}

export async function findConflicts(cand: {
  id?: string; name: string; building: string; room: number; start: string; end: string;
}): Promise<Conflict[]> {
  const { reservations } = await loadAll();
  const out: Conflict[] = [];
  for (const r of reservations) {
    if (cand.id && r.id === cand.id) continue;
    const days = overlapDays(r.start, r.end, cand.start, cand.end);
    if (!days.length) continue;
    if (r.building === cand.building && r.room === cand.room) {
      // 同日交代（退所日＝入所日で、重なりがその1日だけ）はふつうの入れ替わりなので通す
      if (isHandover(r.start, r.end, cand.start, cand.end)) continue;
      out.push({ kind: 'room', other: r, days });
    }
    else if (r.name === cand.name.trim()) out.push({ kind: 'person', other: r, days });
  }
  return out;
}

// ── 追加・更新・削除 ─────────────────────────────────────────────────

export interface SaveParams {
  id?: string;         // 省略＝新規
  name: string;
  building: string;
  room: number;
  start: string;
  end: string;
  status: ReserveStatus;
  soutai?: SoutaiKind;
  inTime?: string;
  outTime?: string;
  note?: string;
  /**
   * 削除の取り消し用。同じIDの行が見つからなければ、そのIDのまま作り直す。
   * これが無いと「消えている＝他の人が消した」とみなしてエラーにしてしまう。
   */
  restore?: boolean;
}

function validate(p: SaveParams, rooms: Room[]): void {
  if (!p.name?.trim()) throw new Error('氏名を入力してください');
  if (!rooms.some(r => r.building === p.building && r.room === Number(p.room))) {
    throw new Error(`${p.building}${p.room}号 は部屋シートにありません`);
  }
  if (!parseISO(p.start)) throw new Error('開始日が正しくありません');
  if (!parseISO(p.end)) throw new Error('終了日が正しくありません');
  if (p.end < p.start) throw new Error('終了日が開始日より前になっています');
  if (eachDate(p.start, p.end).length > 200) throw new Error('期間が長すぎます（200日まで）');
}

/** 予約を追加（id なし）または更新（id あり）。1回の batchWrite で書く。 */
export async function saveReservation(p: SaveParams): Promise<string> {
  const { grid, rooms } = await loadAll();
  validate(p, rooms);

  let rowIdx = -1;
  if (p.id) {
    if (p.id.startsWith('#')) {
      const n = Number(p.id.slice(1));
      if (Number.isInteger(n) && n >= 1 && n < grid.rows.length) rowIdx = n;
    } else {
      rowIdx = grid.rows.findIndex((r, i) => i >= 1 && cell(r, grid.col['ID']) === p.id);
    }
    // 取り消しのときだけ、消えている行を同じIDで作り直す
    if (rowIdx < 1 && p.restore) rowIdx = grid.rows.length;
    if (rowIdx < 1) throw new Error('この予約は見つかりませんでした（他の人が消した可能性があります）');
  } else {
    rowIdx = grid.rows.length;   // 末尾に追加
  }
  const isNewRow = rowIdx >= grid.rows.length;

  const id = (p.id && !p.id.startsWith('#')) ? p.id
    : `R${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

  const writes: CellWrite[] = [];
  const clears: CellClear[] = [];
  const put = (key: string, value: string | number) => {
    const c = grid.col[key];
    if (value === '' || value == null) clears.push({ sheet: SHEET.reserve, row: rowIdx, col: c });
    else writes.push({ sheet: SHEET.reserve, row: rowIdx, col: c, value });
    // 見出しが無くて右端に作った列は、見出しも一緒に書く
    if (c >= grid.headWidth) writes.push({ sheet: SHEET.reserve, row: 0, col: c, value: key });
  };

  put('ID', id);
  put('氏名', p.name.trim());
  put('棟', p.building);
  put('部屋', Number(p.room));
  put('開始日', p.start);
  put('終了日', p.end);
  put('状態', p.status === '確定' ? '確定' : '仮予約');
  // 送迎の有無と入退所の時間は独立。送迎なしでも時間は残す。
  put('送迎', p.soutai === '家族送迎' ? '家族送迎' : p.soutai === '送迎あり' ? '送迎あり' : '');
  put('入所時間', (p.inTime ?? '').trim());
  put('退所時間', (p.outTime ?? '').trim());
  put('備考', (p.note ?? '').trim());
  if (isNewRow) put('登録日時', nowStamp());

  await batchWrite(writes, clears);
  // 消したものを戻したときは、削除ログ側にも「取消」と印を付けて食い違いを残さない
  if (p.restore) await markDeletionUndone(id);
  return id;
}

/** 予約を1件削除（行ごと削除）。 */
export async function deleteReservation(id: string): Promise<Reservation> {
  const { grid } = await loadAll();
  let rowIdx = -1;
  if (id.startsWith('#')) {
    const n = Number(id.slice(1));
    if (Number.isInteger(n) && n >= 1 && n < grid.rows.length) rowIdx = n;
  } else {
    rowIdx = grid.rows.findIndex((r, i) => i >= 1 && cell(r, grid.col['ID']) === id);
  }
  if (rowIdx < 1) throw new Error('この予約は見つかりませんでした');

  const removed = parseRow(grid.rows[rowIdx], grid.col, rowIdx);
  if (!removed) throw new Error('この予約は見つかりませんでした');

  // 先に削除ログへ退避してから消す。順番が逆だと、ログを書く前に落ちたときに中身が失われる。
  await logDeletion(removed);

  const out = grid.rows.map(r => r.map((c: any) => (c === '' ? null : c)));
  out.splice(rowIdx, 1);
  await writeSheetAoa(SHEET.reserve, out);
  return removed;
}

// ── 削除ログ ─────────────────────────────────────────────────────────
// 消した予約は「削除ログ」シートに1行ずつ積む。画面の「↩ 削除を取り消す」は
// その場でしか使えないので、あとから気づいたときはこのシートから拾い直す。

const TRASH_COLS = ['削除日時', '取消', 'ID', '氏名', '棟', '部屋', '開始日', '終了日',
  '状態', '送迎', '入所時間', '退所時間', '備考', '登録日時'] as const;

function trashRowOf(r: Reservation): any[] {
  return [nowStamp(), '', r.id, r.name, r.building, r.room, r.start, r.end,
    r.status, r.soutai, r.inTime, r.outTime, r.note, r.createdAt];
}

async function logDeletion(r: Reservation): Promise<void> {
  await ensureSheetExists(SHEET.trash, [...TRASH_COLS]);
  await appendRow(SHEET.trash, trashRowOf(r));
}

/**
 * 削除ログの該当行に「取消」の印を付ける（削除を取り消したとき）。
 * 同じIDが何度も消されている場合は、いちばん新しい未取消の行に付ける。
 * ログが読めなくても復元自体は成功しているので、ここで失敗しても投げない。
 */
async function markDeletionUndone(id: string): Promise<void> {
  try {
    const rows = (await readSheets([SHEET.trash]))[SHEET.trash] ?? [];
    if (rows.length < 2) return;
    const head = (rows[0] ?? []).map((c: any) => String(c ?? '').trim());
    const idCol = head.indexOf('ID');
    let undoCol = head.indexOf('取消');
    if (idCol < 0) return;
    const writes: CellWrite[] = [];
    if (undoCol < 0) {
      undoCol = rows.reduce((m, r) => Math.max(m, r.length), head.length);
      writes.push({ sheet: SHEET.trash, row: 0, col: undoCol, value: '取消' });
    }
    for (let i = rows.length - 1; i >= 1; i--) {
      if (cell(rows[i], idCol) !== id) continue;
      if (cell(rows[i], undoCol)) continue;      // すでに取消済みの行は飛ばす
      writes.push({ sheet: SHEET.trash, row: i, col: undoCol, value: `取消 ${nowStamp()}` });
      break;
    }
    if (writes.length) await batchWrite(writes);
  } catch { /* ログの更新に失敗しても復元は済んでいるので黙って続ける */ }
}

/** 削除ログの一覧（新しい順）。取消済みも含めて返し、画面側で分ける。 */
export interface TrashEntry {
  deletedAt: string; undone: string;
  id: string; name: string; building: string; room: number;
  start: string; end: string; status: ReserveStatus; soutai: SoutaiKind;
  inTime: string; outTime: string; note: string;
}

export async function listTrash(limit = 50): Promise<TrashEntry[]> {
  let rows: any[][];
  try {
    rows = (await readSheets([SHEET.trash]))[SHEET.trash] ?? [];
  } catch { return []; }          // シートがまだ無い＝1件も消していない
  if (rows.length < 2) return [];
  const head = (rows[0] ?? []).map((c: any) => String(c ?? '').trim());
  const c = (k: string) => head.indexOf(k);
  const out: TrashEntry[] = [];
  for (let i = rows.length - 1; i >= 1 && out.length < limit; i--) {
    const name = cell(rows[i], c('氏名'));
    if (!name) continue;
    out.push({
      deletedAt: cell(rows[i], c('削除日時')),
      undone: cell(rows[i], c('取消')),
      id: cell(rows[i], c('ID')),
      name,
      building: cell(rows[i], c('棟')),
      room: Number(cell(rows[i], c('部屋'))) || 0,
      start: cell(rows[i], c('開始日')),
      end: cell(rows[i], c('終了日')),
      status: cell(rows[i], c('状態')) === '確定' ? '確定' : '仮予約',
      soutai: parseSoutai(cell(rows[i], c('送迎'))),
      inTime: cell(rows[i], c('入所時間')),
      outTime: cell(rows[i], c('退所時間')),
      note: cell(rows[i], c('備考')),
    });
  }
  return out;
}
