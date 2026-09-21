// 予約台帳のデータ操作（このアプリ単体で完結）。
//
// スプレッドシートは3シート：
//   予約   … 1予約=1行。この台帳が正。
//   利用者 … 氏名の候補（ふりがな順）。
//   部屋   … さくら/すみれの部屋。増減はシートを直せばよく、コードは触らなくていい。
//
// 列はすべて見出し名で探す（列番号のべた書きはしない）。見出しが無ければ右端に作る。
// 食事管理アプリの ショート_名 で「列10が非表示と衝突して人が消える」事故があったため。

import { readSheets, writeSheetAoa, batchWrite, SHEET, type CellWrite, type CellClear } from './sheets';

const COLS = ['ID', '氏名', '棟', '部屋', '開始日', '終了日', '状態', '送迎', '迎え時間', '送り時間', '備考', '登録日時'] as const;

export type ReserveStatus = '仮予約' | '確定';

export interface Reservation {
  id: string;
  name: string;
  building: string;
  room: number;
  start: string;      // YYYY-MM-DD（初日＝入所日）
  end: string;        // YYYY-MM-DD（最終日＝退所日）
  status: ReserveStatus;
  soutai: boolean;    // 送迎あり
  pickupTime: string; // 迎え（入所日）
  dropTime: string;   // 送り（退所日）
  note: string;
  createdAt: string;
  rowIdx: number;     // シート上の行（0始まり・内部用）
}

export interface Room { building: string; room: number; disabled: boolean; note: string; }
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
  const soutai = cell(row, col['送迎']);
  return {
    // 手で足された行（IDなし）も拾えるよう、無ければ行番号から作る
    id: cell(row, col['ID']) || `#${rowIdx}`,
    name,
    building: cell(row, col['棟']),
    room: Number(cell(row, col['部屋'])) || 0,
    start, end,
    status: cell(row, col['状態']) === '確定' ? '確定' : '仮予約',
    soutai: soutai !== '' && soutai !== 'なし',
    pickupTime: cell(row, col['迎え時間']),
    dropTime: cell(row, col['送り時間']),
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
  const rc = indexColumns(roomRows, ['棟', '部屋', '使用しない', '備考']).col;
  const rooms: Room[] = roomRows.slice(1)
    .map(r => ({
      building: cell(r, rc['棟']),
      room: Number(cell(r, rc['部屋'])) || 0,
      disabled: cell(r, rc['使用しない']) !== '',
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
  const vacancies: Vacancy[] = rooms.filter(r => !r.disabled).map(r => {
    const takenBy = reservations
      .filter(x => x.id !== excludeId && x.building === r.building && x.room === r.room
        && overlaps(x.start, x.end, start, end))
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
    if (r.building === cand.building && r.room === cand.room) out.push({ kind: 'room', other: r, days });
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
  soutai?: boolean;
  pickupTime?: string;
  dropTime?: string;
  note?: string;
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
    if (rowIdx < 1) throw new Error('この予約は見つかりませんでした（他の人が消した可能性があります）');
  } else {
    rowIdx = grid.rows.length;   // 末尾に追加
  }

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
  put('送迎', p.soutai ? 'あり' : '');
  put('迎え時間', p.soutai ? (p.pickupTime ?? '').trim() : '');
  put('送り時間', p.soutai ? (p.dropTime ?? '').trim() : '');
  put('備考', (p.note ?? '').trim());
  if (!p.id) put('登録日時', nowStamp());

  await batchWrite(writes, clears);
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
  const out = grid.rows.map(r => r.map((c: any) => (c === '' ? null : c)));
  out.splice(rowIdx, 1);
  await writeSheetAoa(SHEET.reserve, out);
  return removed;
}
