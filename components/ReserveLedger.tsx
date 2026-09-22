'use client';

// 予約台帳の本体。部屋×日付のマトリクス＋予約の追加/編集。
//
// 現場の手間に合わせて入れてあるもの：
//  ・予約の塊をドラッグ＆ドロップで動かせる（部屋替えと日付ずらしを1操作で）
//  ・入れ替え用の「仮置き」部屋（実在しないので空き部屋数には数えない）
//  ・期間を入れるとその場で空き部屋が分かる（部屋の選択肢に ○/× と、ふさいでいる人の名前）
//  ・同じ部屋の二重予約と、同じ人を同じ日に別の部屋へ入れる「逆ダブルブッキング」を保存前に知らせる
//  ・すでに入っている逆ダブルブッキングは表の中で赤く出す
//  ・期間の変更は ±1日ボタンでも（延長・短縮が多いため）

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Person } from './ReserveApp';
import { mealsFor, MEAL_KEYS, type MealKey } from '@/lib/meal-rule';

type SoutaiKind = '' | '送迎あり' | '家族送迎';

interface Reservation {
  id: string;
  name: string;
  building: string;
  room: number;
  start: string;
  end: string;
  status: '仮予約' | '確定';
  soutai: SoutaiKind;
  inTime: string;    // 入所時間（初日）
  outTime: string;   // 退所時間（最終日）
  note: string;
  createdAt: string;
}

/** 家族送迎は時間の前に「FA」を付けて出す */
const timeLabel = (rv: Reservation, t: string) => (rv.soutai === '家族送迎' ? `FA ${t}` : t);
interface Room { building: string; room: number; disabled: boolean; staging: boolean; note: string; }
interface Conflict { kind: 'room' | 'person'; other: Reservation; days: string[]; }
interface Vacancy {
  building: string; room: number; free: boolean;
  takenBy?: { name: string; start: string; end: string; status: string }[];
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;
// 食事管理アプリのショート全体一覧に合わせた列幅と食事行
const OV_W = { bld: 26, room: 34, meal: 22 };
const DAY_MIN = 54;   // 日付列の最小幅(px)。これより狭くはせず横スクロールにする（食事管理アプリと同じ）
const MEAL_ROWS: { key: MealKey; label: string; tint: string }[] = [
  { key: 'asa',  label: '朝', tint: 'bg-amber-50' },
  { key: 'hiru', label: '昼', tint: 'bg-sky-50' },
  { key: 'yu',   label: '夕', tint: 'bg-indigo-50' },
];

const dowOf = (y: number, m: number, d: number) => WD[new Date(y, m - 1, d).getDay()];
const dowColor = (w: string) => (w === '日' ? 'text-red-500' : w === '土' ? 'text-blue-500' : 'text-gray-500');
const dowBg = (w: string) => (w === '日' ? 'bg-red-50' : w === '土' ? 'bg-blue-50' : '');

/**
 * 列幅に収まる文字サイズ。1部屋3行（朝昼夕）にしたので氏名は1行で出す。
 * 食事管理アプリの全体一覧と同じ考え方＝列幅 ÷ 文字数。
 * 画面が広いほど列が広がり、自動的に文字も大きくなる。
 */
function fontPxFor(s: string, dayW: number): number {
  const n = Math.max(1, String(s ?? '').length);
  return Math.max(6, Math.min(12, Math.floor(dayW / n)));
}

const todayISO = () => {
  const d = new Date();
  return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

/** ISO日付に n 日足す */
function addDays(iso: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n);
  return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** 泊数（終了日 − 開始日） */
const nightsOf = (start: string, end: string) =>
  Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000);

/**
 * 時刻を5分単位に丸める（"10:03" → "10:05"）。
 * 入力欄は step=300 で5分刻みにしてあるが、手打ちやコピー貼り付けの端数もここで吸収する。
 * 60分に繰り上がったら次の時へ。24時を越えたら 23:55 で止める。
 */
function snapTo5(t: string): string {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(t ?? '').trim());
  if (!m) return t;
  let h = Number(m[1]);
  let mi = Math.round(Number(m[2]) / 5) * 5;
  if (mi >= 60) { mi = 0; h += 1; }
  if (h >= 24) return '23:55';
  return `${pad2(h)}:${pad2(mi)}`;
}

const mdOf = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[2])}/${Number(m[3])}` : iso;
};

interface FormState {
  id: string;            // '' = 新規
  name: string;
  building: string;
  room: number;
  start: string;
  end: string;
  status: '仮予約' | '確定';
  soutai: SoutaiKind;
  inTime: string;
  outTime: string;
  note: string;
}

/** ドラッグ中の塊と、つかんだ日（表の何列目か） */
interface DragState { rv: Reservation; grabIdx: number; }
/** ドロップ先のプレビュー（この部屋のこの期間に入る） */
interface DropPreview { building: string; room: number; start: string; end: string; }
/** 書こうとしたら重なりが見つかったときの確認（移動・削除の取り消しで共用） */
interface AskState { title: string; conflicts: Conflict[]; confirmLabel: string; onConfirm: () => void; }

/** 削除ログの1行 */
interface TrashEntry {
  deletedAt: string; undone: string;
  id: string; name: string; building: string; room: number;
  start: string; end: string; status: '仮予約' | '確定'; soutai: SoutaiKind;
  inTime: string; outTime: string; note: string;
}

interface Props { year: number; month: number; people: Person[]; }

export default function ReserveLedger({ year, month, people }: Props) {
  const [rows, setRows] = useState<Reservation[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [daysInMonth, setDaysInMonth] = useState(new Date(year, month, 0).getDate());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState<FormState | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [vacancy, setVacancy] = useState<{ vacancies: Vacancy[]; freeCount: number } | null>(null);
  const [vacLoading, setVacLoading] = useState(false);

  // ドラッグ＆ドロップ
  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<DropPreview | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  // 直前の1回だけ戻せるようにする（掴み間違い・消し間違いの取り消し）
  const [lastMove, setLastMove] = useState<{ id: string; name: string; building: string; room: number; start: string; end: string } | null>(null);
  const [lastDelete, setLastDelete] = useState<Reservation | null>(null);
  // 削除ログ（消した予約の履歴）。開いたときだけ読む。
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<TrashEntry[] | null>(null);
  // 表を置ける幅（列幅を画面いっぱいに広げるため。食事管理アプリの全体一覧と同じ）
  const bodyRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState(0);
  useEffect(() => {
    const measure = () => { if (bodyRef.current) setAvailW(bodyRef.current.clientWidth); };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  const load = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setError(''); }
    try {
      const res = await fetch(`/api/reserve?year=${year}&month=${month}`, { cache: 'no-store' });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setRows(j.reservations ?? []);
      setRooms(j.rooms ?? []);
      setDaysInMonth(j.daysInMonth);
    } catch (e: any) {
      if (silent) setMsg(`⚠ 更新に失敗：${e.message || '読み込み失敗'}`);
      else setError(e.message || '読み込み失敗');
    } finally { if (!silent) setLoading(false); }
  }, [year, month]);

  useEffect(() => {
    setForm(null); setConflicts(null); setMsg(''); setAsk(null); setLastMove(null); setLastDelete(null);
    load();
  }, [load]);

  // 建物ごとの部屋（部屋シートの並びを尊重する）。仮置きは最後にまとまる。
  const buildings = useMemo(() => {
    const out: { name: string; staging: boolean; rooms: Room[] }[] = [];
    for (const r of rooms) {
      let g = out.find(x => x.name === r.building);
      if (!g) { g = { name: r.building, staging: r.staging, rooms: [] }; out.push(g); }
      g.rooms.push(r);
    }
    return out;
  }, [rooms]);

  // 部屋×日付の割り当て。1マスに複数入るのは同じ部屋の二重予約。
  const grid = useMemo(() => {
    const map = new Map<string, Reservation[][]>();
    for (const r of rooms) map.set(`${r.building}-${r.room}`, Array.from({ length: daysInMonth }, () => [] as Reservation[]));
    for (const rv of rows) {
      const cells = map.get(`${rv.building}-${rv.room}`);
      if (!cells) continue;
      for (let d = 1; d <= daysInMonth; d++) {
        const iso = isoOf(year, month, d);
        if (iso >= rv.start && iso <= rv.end) cells[d - 1].push(rv);
      }
    }
    return map;
  }, [rows, rooms, daysInMonth, year, month]);

  /**
   * 部屋×日付×食事のマス目。
   * eaters = その食事を食べる人（入退所の時刻から lib/meal-rule.ts が決める）。
   * stay   = 在室しているがその食事はない人（食事管理アプリと同じく薄字で出す）。
   */
  interface MealCell { eaters: Reservation[]; stay?: Reservation; }
  const mealGrid = useMemo(() => {
    const map = new Map<string, MealCell[][]>();
    for (const r of rooms) {
      const key = `${r.building}-${r.room}`;
      const cells = grid.get(key) ?? [];
      map.set(key, Array.from({ length: daysInMonth }, (_, i) => {
        const iso = isoOf(year, month, i + 1);
        const list = cells[i] ?? [];
        return MEAL_KEYS.map(mk => {
          const eaters = list.filter(rv => mealsFor(rv, iso)[mk]);
          const stay = eaters.length ? undefined : list[0];
          return { eaters, stay };
        });
      }));
    }
    return map;
  }, [grid, rooms, daysInMonth, year, month]);

  /** そのマスに出ている人（食べる人 → いなければ在室だけの人）。塊の枠を描くのに使う。 */
  const occAt = useCallback((roomKey: string, dayIdx: number, mealIdx: number): Reservation | undefined => {
    const c = mealGrid.get(roomKey)?.[dayIdx]?.[mealIdx];
    return c?.eaters[0] ?? c?.stay;
  }, [mealGrid]);

  // 逆ダブルブッキング：同じ人が同じ日に2部屋以上に入っているマス
  const doubleBooked = useMemo(() => {
    const perDay = new Map<string, Set<string>>();
    for (const rv of rows) {
      for (let d = 1; d <= daysInMonth; d++) {
        const iso = isoOf(year, month, d);
        if (iso < rv.start || iso > rv.end) continue;
        const k = `${rv.name}|${iso}`;
        if (!perDay.has(k)) perDay.set(k, new Set());
        perDay.get(k)!.add(`${rv.building}-${rv.room}`);
      }
    }
    const bad = new Set<string>();
    for (const [k, set] of perDay) if (set.size > 1) bad.add(k);
    return bad;
  }, [rows, daysInMonth, year, month]);

  /** 実在する部屋（仮置きと「使用しない」を除く）。稼働率と空き数の分母。 */
  const realRooms = useMemo(() => rooms.filter(r => !r.disabled && !r.staging), [rooms]);

  // その日に空いている部屋数（仮置きは実在しないので数えない）
  const vacantPerDay = useMemo(() => Array.from({ length: daysInMonth }, (_, i) =>
    realRooms.reduce((n, r) => n + ((grid.get(`${r.building}-${r.room}`)?.[i]?.length ?? 0) ? 0 : 1), 0)),
    [grid, realRooms, daysInMonth]);

  /** 棟ごとの利用者数（その日その棟にいる人の数）。1部屋に2人重なっていれば2人と数える。 */
  const countsPerBuilding = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const b of buildings) {
      if (b.staging) continue;
      out.set(b.name, Array.from({ length: daysInMonth }, (_, i) => {
        const names = new Set<string>();
        for (const rm of b.rooms) {
          if (rm.disabled) continue;
          for (const rv of grid.get(`${b.name}-${rm.room}`)?.[i] ?? []) names.add(rv.name);
        }
        return names.size;
      }));
    }
    return out;
  }, [buildings, grid, daysInMonth]);

  /**
   * 稼働率＝（埋まっていた部屋×日）÷（部屋数×日数）。
   * 例：30日の月で10日だけ全室満室、残り20日が全室空きなら 10/30 = 33%。
   */
  const occupancy = useMemo(() => {
    const total = realRooms.length * daysInMonth;
    if (!total) return null;
    const used = vacantPerDay.reduce((n, v) => n + (realRooms.length - v), 0);
    return { used, total, pct: Math.round((used / total) * 100) };
  }, [realRooms, daysInMonth, vacantPerDay]);

  // ── 期間を入れたら空き部屋を調べる（問い合わせ中にすぐ答えるため） ──
  useEffect(() => {
    if (!form?.start || !form?.end || form.end < form.start) { setVacancy(null); return; }
    let alive = true;
    setVacLoading(true);
    const t = setTimeout(async () => {
      try {
        const q = new URLSearchParams({ start: form.start, end: form.end });
        if (form.id) q.set('excludeId', form.id);
        const j = await (await fetch(`/api/vacancy?${q}`, { cache: 'no-store' })).json();
        if (alive) setVacancy(j.error ? null : j);
      } catch { if (alive) setVacancy(null); }
      finally { if (alive) setVacLoading(false); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [form?.start, form?.end, form?.id]);

  const vacOf = (building: string, room: number) =>
    vacancy?.vacancies.find(v => v.building === building && v.room === room);

  const openNew = (building: string, room: number, iso: string) => {
    setForm({
      id: '', name: '', building, room, start: iso, end: iso,
      // 時刻の既定値。空にすると時刻欄が「いまの時刻」から始まって使いにくいため。
      status: '仮予約', soutai: '', inTime: '09:00', outTime: '16:00', note: '',
    });
    setConflicts(null); setMsg('');
  };
  const openEdit = (rv: Reservation) => {
    setForm({
      id: rv.id, name: rv.name, building: rv.building, room: rv.room,
      start: rv.start, end: rv.end, status: rv.status,
      soutai: rv.soutai, inTime: rv.inTime, outTime: rv.outTime, note: rv.note,
    });
    setConflicts(null); setMsg('');
  };

  const patch = (p: Partial<FormState>) => setForm(f => (f ? { ...f, ...p } : f));

  const doSave = async (force = false) => {
    if (!form) return;
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/reserve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, id: form.id || undefined, force }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '保存エラー');
      if (j.conflict) { setConflicts(j.conflicts); return; }
      const label = `${form.name} さん（${form.building}${pad2(form.room)}号 ${form.start}〜${form.end}・${form.status}）`;
      setConflicts(null); setForm(null);
      await load(true);
      setMsg(`✓ ${label} を保存しました`);
    } catch (e: any) { setMsg(`⚠ ${e.message}`); } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (!form?.id) return;
    if (!window.confirm(`${form.name} さん（${form.building}${pad2(form.room)}号 ${form.start}〜${form.end}）の予約を削除します。よろしいですか？\n（消したあと「↩ 削除を取り消す」で戻せます）`)) return;
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/reserve', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: form.id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '削除エラー');
      setForm(null); setConflicts(null);
      setLastDelete(j.removed ?? null);   // 取り消せるように消した中身を覚えておく
      await load(true);
      setMsg(`✓ ${j.removed?.name ?? ''} さんの予約を削除しました（取り消せます）`);
    } catch (e: any) { setMsg(`⚠ ${e.message}`); } finally { setBusy(false); }
  };

  const loadTrash = useCallback(async () => {
    try {
      const j = await (await fetch('/api/trash', { cache: 'no-store' })).json();
      setTrash(j.entries ?? []);
    } catch { setTrash([]); }
  }, []);

  /**
   * 消した予約を戻す。消したときと同じIDで作り直すので、消す前と同じ1行に戻る。
   * 引数なし＝直前の削除、entry あり＝削除ログから選んだもの。
   */
  const restoreDeleted = async (force = false, entry?: TrashEntry) => {
    const rv: Reservation | TrashEntry | null = entry ?? lastDelete;
    if (!rv) return;
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/reserve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...rv, restore: true, force }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '取り消しエラー');
      if (j.conflict) {
        setAsk({
          title: `${rv.name} さん（${rv.building}${pad2(rv.room)}号 ${mdOf(rv.start)}〜${mdOf(rv.end)}）を戻すと重なります（まだ戻していません）`,
          conflicts: j.conflicts, confirmLabel: '重なったまま戻す',
          onConfirm: () => restoreDeleted(true, entry),
        });
        return;
      }
      setAsk(null);
      if (!entry) setLastDelete(null);
      await load(true);
      if (trashOpen) await loadTrash();
      setMsg(`↩ ${rv.name} さん（${rv.building}${pad2(rv.room)}号 ${mdOf(rv.start)}〜${mdOf(rv.end)}）の削除を取り消しました`);
    } catch (e: any) { setMsg(`⚠ ${e.message}`); } finally { setBusy(false); }
  };

  // ── 塊の移動（ドラッグ＆ドロップと「戻す」から呼ぶ） ─────────────────

  /**
   * 予約1件を別の部屋・別の期間へ移す。氏名や送迎などはそのまま持っていく。
   * force でないときは重なりを確認して、返事をもらってから書く。
   */
  const moveReservation = async (
    rv: Reservation, building: string, room: number, start: string, end: string,
    opts?: { force?: boolean; undo?: boolean },
  ) => {
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/reserve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: rv.id, name: rv.name, building, room, start, end, status: rv.status,
          soutai: rv.soutai, inTime: rv.inTime, outTime: rv.outTime, note: rv.note,
          force: !!opts?.force,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '移動エラー');
      if (j.conflict) {
        setAsk({
          title: `${rv.name} さんを ${building}${pad2(room)}号 ${mdOf(start)}〜${mdOf(end)} へ移すと重なります（まだ動かしていません）`,
          conflicts: j.conflicts, confirmLabel: '重なったまま移す',
          onConfirm: () => moveReservation(rv, building, room, start, end, { force: true }),
        });
        return;
      }
      setAsk(null);
      // 戻した直後にまた「戻す」が出ると混乱するので、undo のときは覚えない
      setLastMove(opts?.undo ? null
        : { id: rv.id, name: rv.name, building: rv.building, room: rv.room, start: rv.start, end: rv.end });
      await load(true);
      setMsg(opts?.undo
        ? `↩ ${rv.name} さんを ${building}${pad2(room)}号 ${mdOf(start)}〜${mdOf(end)} に戻しました`
        : `✓ ${rv.name} さんを ${building}${pad2(room)}号 ${mdOf(start)}〜${mdOf(end)} へ移しました`);
    } catch (e: any) { setMsg(`⚠ ${e.message}`); } finally { setBusy(false); }
  };

  const doUndoMove = async () => {
    if (!lastMove) return;
    const cur = rows.find(r => r.id === lastMove.id);
    if (!cur) { setMsg('⚠ 戻せませんでした：その予約が見つかりません'); setLastMove(null); return; }
    await moveReservation(cur, lastMove.building, lastMove.room, lastMove.start, lastMove.end, { undo: true });
  };

  // ── ドラッグ＆ドロップ ───────────────────────────────────────────────

  const clearDrag = () => { setDrag(null); setPreview(null); };

  const onDragStart = (e: React.DragEvent, rv: Reservation, idx: number) => {
    if (busy) { e.preventDefault(); return; }
    setDrag({ rv, grabIdx: idx });
    setAsk(null);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox はデータを入れないとドラッグが始まらない
    e.dataTransfer.setData('text/plain', rv.id);
  };

  /** つかんだ日から何日ずれたか → 塊ごと同じ日数だけ動かす */
  const shifted = (d: DragState, idx: number) => {
    const delta = idx - d.grabIdx;
    return { start: addDays(d.rv.start, delta), end: addDays(d.rv.end, delta), delta };
  };

  const onDragOver = (e: React.DragEvent, building: string, room: number, idx: number) => {
    if (!drag) return;
    e.preventDefault();                       // これが無いとドロップできない
    e.dataTransfer.dropEffect = 'move';
    const { start, end } = shifted(drag, idx);
    if (preview && preview.building === building && preview.room === room && preview.start === start) return;
    setPreview({ building, room, start, end });
  };

  const onDrop = (e: React.DragEvent, building: string, room: number, idx: number) => {
    e.preventDefault();
    if (!drag) return;
    const { rv } = drag;
    const { start, end, delta } = shifted(drag, idx);
    clearDrag();
    if (building === rv.building && room === rv.room && delta === 0) return;   // 動いていない
    moveReservation(rv, building, room, start, end);
  };

  const nameKnown = !form?.name.trim() || people.some(p => p.name === form.name.trim());
  const dates = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const today = todayISO();
  const formNights = form ? nightsOf(form.start, form.end) : 0;
  const freeList = vacancy?.vacancies.filter(v => v.free) ?? [];

  // 日付列の幅＝画面の空き幅を日数で割って広げる（狭い画面では DAY_MIN で横スクロール）
  const fixedW = OV_W.bld + OV_W.room + OV_W.meal;
  const dayW = Math.max(DAY_MIN, Math.floor(((availW || 0) - fixedW) / daysInMonth) || 0);

  /**
   * 下の一覧はあいうえお順（利用者シートのふりがな）。
   * ふりがなが無い人は末尾にまわし、そのなかは氏名の読み順。
   * 同じ人が複数回いる場合は期間の早い順。
   */
  const furiOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of people) m.set(p.name, p.furi);
    return m;
  }, [people]);

  const listRows = useMemo(() => [...rows].sort((a, b) => {
    const fa = furiOf.get(a.name) ?? '', fb = furiOf.get(b.name) ?? '';
    if (!fa && fb) return 1;
    if (fa && !fb) return -1;
    return fa.localeCompare(fb, 'ja')
      || a.name.localeCompare(b.name, 'ja')
      || a.start.localeCompare(b.start);
  }), [rows, furiOf]);

  return (
    <div className="rv-print space-y-4">
      <style>{`
        @media print {
          @page { size: A3 landscape; margin: 6mm; }
          body * { visibility: hidden !important; }
          .rv-print, .rv-print * { visibility: visible !important; }
          .rv-print { position: absolute; left: 0; top: 0; width: 100%; }
          .rv-noprint, .rsv-noprint { display: none !important; }
          .rv-scroll { overflow: visible !important; max-height: none !important; }
          .rv-fix { position: static !important; }
        }
        .rv-table { border-collapse: collapse; table-layout: fixed; }
        /* 横線（部屋と部屋の区切り）は縦線より太くする＝行を目で追いやすい */
        .rv-table th, .rv-table td {
          border: 1px solid #eef1f5; border-bottom: 2px solid #cbd5e1;
          white-space: nowrap; text-align: center; overflow: hidden;
        }
        .rv-table tbody tr.rv-bldend td, .rv-table tbody tr.rv-bldend th { border-bottom: 3px solid #94a3b8; }
        /* 部屋の区切り（朝昼夕の3行が1部屋） */
        .rv-table tbody tr.rv-roomend td, .rv-table tbody tr.rv-roomend th { border-bottom: 2px solid #cbd5e1; }
        /* 予約の塊を枠で囲う。border-collapse と喧嘩しないよう内側の影で描く。
           隣のマスと同じ人かどうかで辺を出し分けるので、月またぎや同日交代も自然に囲える。 */
        .rv-t { --bt: inset 0 2px 0 #1e293b; }
        .rv-b { --bb: inset 0 -2px 0 #1e293b; }
        .rv-l { --bl: inset 2px 0 0 #1e293b; }
        .rv-r { --br: inset -2px 0 0 #1e293b; }
        .rv-table td { --bt: 0 0 #0000; --bb: 0 0 #0000; --bl: 0 0 #0000; --br: 0 0 #0000;
          box-shadow: var(--bt), var(--bb), var(--bl), var(--br); }
        /* 左に固定する2列。背景色は各セルのクラスに任せる（ここで白を敷くと棟の色が消える）。 */
        .rv-fix { position: sticky; }
        .rv-table thead .rv-fix { z-index: 25; }
        .rv-table tbody .rv-fix { z-index: 5; }
        /* 仮予約：確定と一目で見分けられるよう斜線を敷く（印刷でも残る） */
        .rv-kari { background-image: repeating-linear-gradient(45deg, rgba(0,0,0,.05) 0 3px, transparent 3px 6px); }
        /* 予約のマスはつまんで動かせる */
        .rv-grab { cursor: grab; }
        .rv-grab:active { cursor: grabbing; }
        /* 入所時間（初日の名前の上）・退所時間（最終日の名前の下）。家族送迎は FA 付き。 */
        .rv-time { font-size: 8px; line-height: 1.1; letter-spacing: -.04em; color: #475569; font-weight: 400; }
        /* 氏名は苗字と名前で2段。1段あたりが短くなるぶん文字を大きくできる。
           書体はメイリオ指定（現場の見やすさ優先。無い環境では既定のゴシックに落ちる）。 */
        /* 書体は明朝。太字にしないほうが字面が静かで読みやすい（現場の指定）。 */
        .rv-name {
          line-height: 1.12; font-weight: 400;
          font-family: "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "MS PMincho", "MS Mincho", serif;
        }
        /* 行の高さを全部そろえる。いちばん背の高い「入所時間＋氏名2段＋退所時間」に合わせる
           ＝日によって行がガタつかず、横に目で追える。はみ出しは td の overflow:hidden で切る。 */
        /* 1部屋＝朝昼夕の3行。1行は氏名1行ぶんの高さでそろえる。 */
        .rv-table tbody tr.rv-mealrow td, .rv-table tbody tr.rv-mealrow th { height: 18px; }
        /* 在室だがその食事はない人。空室（・）と見分けられるよう薄く出す（食事管理アプリと同じ）。 */
        .rv-stay { color: #cbd5e1; font-style: italic; }
        @media print { .rv-stay { color: #94a3b8 !important;
          -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; } }
      `}</style>

      <div className="rv-noprint flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">{year}年{month}月の予約</h2>
        <span className="text-sm text-gray-500">
          確定 {rows.filter(r => r.status === '確定').length}件 ／ 仮予約 {rows.filter(r => r.status === '仮予約').length}件
        </span>
        {occupancy && (
          <span className="text-sm font-bold text-indigo-700"
            title={`埋まっていた ${occupancy.used} 室日 ÷ ${realRooms.length}室 × ${daysInMonth}日 = ${occupancy.total} 室日`}>
            稼働率 {occupancy.pct}%
            <span className="ml-1 font-normal text-xs text-gray-400">（{occupancy.used}/{occupancy.total} 室日）</span>
          </span>
        )}
        {lastDelete && (
          <button disabled={busy} onClick={() => restoreDeleted()}
            title={`${lastDelete.name} さん ${lastDelete.building}${pad2(lastDelete.room)}号 ${lastDelete.start}〜${lastDelete.end}`}
            className="rounded-lg bg-red-600 text-white px-3 py-2 text-sm font-bold hover:bg-red-700 disabled:opacity-40">
            ↩ 削除を取り消す（{lastDelete.name}）
          </button>
        )}
        {lastMove && (
          <button disabled={busy} onClick={doUndoMove}
            className="rounded-lg bg-amber-500 text-white px-3 py-2 text-sm font-bold hover:bg-amber-600 disabled:opacity-40">
            ↩ 直前の移動を戻す
          </button>
        )}
        <button onClick={() => openNew(rooms[0]?.building ?? 'さくら', rooms[0]?.room ?? 1, isoOf(year, month, 1))}
          className="ml-auto bg-emerald-500 text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-emerald-600">＋ 予約を追加</button>
        <button onClick={() => { const open = !trashOpen; setTrashOpen(open); if (open) loadTrash(); }}
          className={`rounded-lg px-3 py-2 text-sm font-semibold ${trashOpen ? 'bg-slate-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`}>
          🗑 削除の履歴
        </button>
        <button onClick={() => window.print()} className="bg-sky-500 text-white rounded-lg px-3 py-2 text-sm font-semibold">🖨 印刷（A3横）</button>
        <button onClick={() => load()} className="bg-gray-200 text-gray-700 rounded-lg px-3 py-2 text-sm font-semibold">🔄 更新</button>
      </div>

      {/* 削除の履歴。消した予約は消さずに「削除ログ」シートへ積んであるので、あとからでも戻せる。 */}
      {trashOpen && (
        <div className="rv-noprint rounded-xl border border-slate-300 bg-white overflow-hidden">
          <div className="px-3 py-2 font-bold text-sm bg-slate-100 border-b border-slate-200 flex items-center gap-2">
            🗑 削除の履歴（新しい順）
            <span className="font-normal text-xs text-slate-500">消した予約は「削除ログ」シートに残っています。月をまたいだぶんも出ます。</span>
            <button onClick={loadTrash} className="ml-auto text-xs text-sky-600 underline">再読込</button>
          </div>
          {trash === null ? <div className="px-3 py-4 text-sm text-gray-400 animate-pulse">読み込み中...</div>
            : trash.length === 0 ? <div className="px-3 py-4 text-sm text-gray-400">まだ1件も削除していません。</div>
            : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 bg-gray-50">
                    <th className="px-3 py-1.5">削除日時</th><th className="px-2 py-1.5">氏名</th>
                    <th className="px-2 py-1.5">部屋</th><th className="px-2 py-1.5">期間</th>
                    <th className="px-2 py-1.5">状態</th><th className="px-2 py-1.5">備考</th>
                    <th className="px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {trash.map((t, i) => (
                    <tr key={`${t.id}-${i}`} className={`border-t border-gray-100 ${t.undone ? 'text-gray-400' : ''}`}>
                      <td className="px-3 py-1.5 tabular-nums text-xs">{t.deletedAt}</td>
                      <td className="px-2 py-1.5 font-medium">{t.name}</td>
                      <td className="px-2 py-1.5">{t.building}{pad2(t.room)}</td>
                      <td className="px-2 py-1.5 tabular-nums text-xs">{t.start} 〜 {t.end}</td>
                      <td className="px-2 py-1.5 text-xs">{t.status}</td>
                      <td className="px-2 py-1.5 text-xs text-gray-500">{t.note}</td>
                      <td className="px-2 py-1.5">
                        {t.undone
                          ? <span className="text-xs text-gray-400">戻しました</span>
                          : <button disabled={busy} onClick={() => restoreDeleted(false, t)}
                              className="px-2 py-1 rounded bg-emerald-500 text-white text-xs font-bold hover:bg-emerald-600 disabled:opacity-40">戻す</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}

      <div className="print:block hidden text-base font-bold mb-1">ショート予約台帳　{year}年{month}月</div>

      {/* ドラッグ中の行き先を文字でも出す（マスが小さいので取り違え防止） */}
      {drag && preview && (
        <div className="rv-noprint rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 font-medium">
          🖐 {drag.rv.name} さん → <b>{preview.building}{pad2(preview.room)}号</b>
          {mdOf(preview.start)} 〜 {mdOf(preview.end)}（{nightsOf(preview.start, preview.end)}泊）
          {preview.start !== drag.rv.start && <span className="ml-2 text-sky-700">
            ※ {mdOf(drag.rv.start)}〜 から {Math.round((new Date(preview.start).getTime() - new Date(drag.rv.start).getTime()) / 86400000) > 0 ? '＋' : ''}
            {Math.round((new Date(preview.start).getTime() - new Date(drag.rv.start).getTime()) / 86400000)}日
          </span>}
        </div>
      )}

      {msg && <div className="rv-noprint rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 font-medium">{msg}</div>}
      {error && <div className="rv-noprint rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">⚠ {error}</div>}
      {doubleBooked.size > 0 && (
        <div className="rv-noprint rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          ⚠ 同じ人が同じ日に2部屋以上に入っています（表の赤いマス）。どちらかを直してください。
        </div>
      )}

      {/* 書こうとしたら重なっていたときの確認（移動・削除の取り消しで共用） */}
      {ask && (
        <div className="rv-noprint rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 space-y-2">
          <div className="font-bold">⚠ {ask.title}</div>
          <ul className="list-disc pl-5 max-h-32 overflow-y-auto">
            {ask.conflicts.map((c, i) => (
              <li key={i}>
                {c.kind === 'room'
                  ? <>その部屋に <b>{c.other.name}</b> さんの{c.other.status}：{mdOf(c.days[0])}〜{mdOf(c.days[c.days.length - 1])}</>
                  : <><b className="text-red-700">同じ人を別の部屋にも</b>：{c.other.building}{pad2(c.other.room)}号 にも{c.other.status}（{mdOf(c.days[0])}〜{mdOf(c.days[c.days.length - 1])}）</>}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2 flex-wrap">
            <button disabled={busy} onClick={ask.onConfirm}
              className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 disabled:opacity-40">{ask.confirmLabel}</button>
            <button disabled={busy} onClick={() => setAsk(null)} className="px-2 py-1.5 text-amber-700 underline">やめる</button>
            <span className="text-xs text-amber-700">※ 入れ替えたいときは、先に片方を「仮置き」へ逃がしてください</span>
          </div>
        </div>
      )}

      {/* 予約の追加・編集 */}
      {form && (
        <div className="rv-noprint rounded-xl border border-emerald-200 bg-white p-4 space-y-3">
          <div className="font-bold text-gray-800">{form.id ? '✏️ 予約を編集' : '＋ 予約を追加'}</div>

          {/* 期間（±1日ボタン付き。延長・短縮が多いので押すだけで直せるように） */}
          <div className="flex items-end gap-3 flex-wrap">
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">開始日（入所日）</span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => patch({ start: addDays(form.start, -1) })}
                  className="px-2 py-1.5 rounded bg-gray-100 hover:bg-gray-200 font-bold">−</button>
                <input type="date" value={form.start}
                  onChange={e => patch({ start: e.target.value, end: form.end < e.target.value ? e.target.value : form.end })}
                  className="border border-gray-200 rounded-md px-2 py-1.5 text-sm" />
                <button type="button" onClick={() => { const s = addDays(form.start, 1); patch({ start: s, end: form.end < s ? s : form.end }); }}
                  className="px-2 py-1.5 rounded bg-gray-100 hover:bg-gray-200 font-bold">＋</button>
              </div>
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">終了日（退所日）</span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => { const e2 = addDays(form.end, -1); if (e2 >= form.start) patch({ end: e2 }); }}
                  className="px-2 py-1.5 rounded bg-gray-100 hover:bg-gray-200 font-bold">−</button>
                <input type="date" value={form.end} min={form.start}
                  onChange={e => patch({ end: e.target.value })}
                  className="border border-gray-200 rounded-md px-2 py-1.5 text-sm" />
                <button type="button" onClick={() => patch({ end: addDays(form.end, 1) })}
                  className="px-2 py-1.5 rounded bg-gray-100 hover:bg-gray-200 font-bold">＋</button>
              </div>
            </label>
            <div className="text-sm text-gray-600 pb-2">{formNights}泊{formNights + 1}日</div>
          </div>

          {/* この期間の空き状況 */}
          <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm">
            {vacLoading ? <span className="text-gray-400 animate-pulse">空き部屋を確認中…</span>
              : !vacancy ? <span className="text-gray-400">期間を入れると空き部屋が出ます</span>
              : freeList.length === 0
                ? <span className="text-red-700 font-bold">この期間に丸ごと空いている部屋はありません</span>
                : <span className="text-slate-700">
                    この期間に空いている部屋：<b className="text-emerald-700">{freeList.length}室</b>
                    <span className="text-xs text-slate-500 ml-2">
                      {freeList.map(v => `${v.building}${pad2(v.room)}`).join('・')}
                    </span>
                  </span>}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">氏名</span>
              <input list="rv-people" value={form.name} onChange={e => patch({ name: e.target.value })}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm" placeholder="氏名を選ぶ / 入力" />
              <datalist id="rv-people">{people.map(p => <option key={p.name} value={p.name}>{p.furi}</option>)}</datalist>
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">棟</span>
              <select value={form.building} onChange={e => patch({ building: e.target.value })}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white">
                {buildings.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">部屋（○＝この期間ずっと空き）</span>
              <select value={form.room} onChange={e => patch({ room: Number(e.target.value) })}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white">
                {(buildings.find(b => b.name === form.building)?.rooms ?? []).map(r => {
                  const v = vacOf(r.building, r.room);
                  const mark = r.staging ? '' : !vacancy ? '' : v?.free ? '　○ 空き' : `　× ${v?.takenBy?.[0]?.name ?? '予約あり'}`;
                  return <option key={r.room} value={r.room}>{pad2(r.room)}号{mark}{r.disabled ? '（使用しない）' : ''}</option>;
                })}
              </select>
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">状態</span>
              <select value={form.status} onChange={e => patch({ status: e.target.value as '仮予約' | '確定' })}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white">
                <option value="仮予約">仮予約</option>
                <option value="確定">確定</option>
              </select>
            </label>
          </div>

          {/* 入退所の時間と送迎区分は別もの。送迎なしでも時間は入れられる。 */}
          <div className="flex items-end gap-3 flex-wrap">
            {/* 時間は5分刻み（step=300）。手で打った端数は5分単位に丸める。 */}
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">入所時間（初日）</span>
              <input type="time" step={300} value={form.inTime}
                onChange={e => patch({ inTime: snapTo5(e.target.value) })}
                className="border border-gray-200 rounded-md px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">退所時間（最終日）</span>
              <input type="time" step={300} value={form.outTime}
                onChange={e => patch({ outTime: snapTo5(e.target.value) })}
                className="border border-gray-200 rounded-md px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">送迎</span>
              <select value={form.soutai} onChange={e => patch({ soutai: e.target.value as SoutaiKind })}
                className="border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white">
                <option value="">なし</option>
                <option value="送迎あり">送迎あり</option>
                <option value="家族送迎">家族送迎（FA）</option>
              </select>
            </label>
            <label className="text-xs text-gray-600 space-y-1 flex-1 min-w-[200px]">
              <span className="font-semibold block">備考</span>
              <input type="text" value={form.note} onChange={e => patch({ note: e.target.value })}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm" placeholder="連絡事項など" />
            </label>
          </div>
          {form.soutai === '家族送迎' && (
            <div className="text-xs text-slate-600">※ 家族送迎の予約は、表の時間の前に <b>FA</b> と出ます。</div>
          )}

          {!nameKnown && (
            <div className="text-xs text-amber-700">
              ※「{form.name}」さんは利用者シートにいません。このまま登録できますが、次回から選べるようにするには利用者シートに足してください。
            </div>
          )}

          {conflicts && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 space-y-2">
              <div className="font-bold">⚠ 予約が重なっています（まだ保存していません）</div>
              <ul className="list-disc pl-5 max-h-32 overflow-y-auto">
                {conflicts.map((c, i) => (
                  <li key={i}>
                    {c.kind === 'room'
                      ? <>同じ部屋（{c.other.building}{pad2(c.other.room)}号）に <b>{c.other.name}</b> さんの{c.other.status}：{mdOf(c.days[0])}〜{mdOf(c.days[c.days.length - 1])}</>
                      : <><b className="text-red-700">同じ人を別の部屋にも</b>：{c.other.name} さんは {c.other.building}{pad2(c.other.room)}号 にも{c.other.status}（{mdOf(c.days[0])}〜{mdOf(c.days[c.days.length - 1])}）</>}
                  </li>
                ))}
              </ul>
              <button disabled={busy} onClick={() => doSave(true)} className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 disabled:opacity-40">重なったまま保存する</button>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button disabled={busy} onClick={() => doSave()} className="px-4 py-2 rounded-lg bg-emerald-500 text-white font-bold hover:bg-emerald-600 disabled:opacity-40">保存</button>
            {form.id && <button disabled={busy} onClick={doDelete} className="px-4 py-2 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 disabled:opacity-40">🗑 削除</button>}
            <button disabled={busy} onClick={() => { setForm(null); setConflicts(null); }} className="px-3 py-2 text-gray-500 underline">閉じる</button>
            {busy && <span className="text-sm text-gray-400 animate-pulse">処理中...</span>}
          </div>
        </div>
      )}

      {/* 部屋×日付 */}
      {loading ? <div className="text-sm text-gray-400 animate-pulse p-4">読み込み中...</div> : (
        <div ref={bodyRef} className="rv-scroll bg-white rounded-xl border border-gray-100 shadow-sm overflow-auto max-h-[64vh] print:max-h-none"
             onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPreview(null); }}>
          <table className="rv-table text-[11px]" style={{ width: fixedW + dayW * daysInMonth }}>
            <colgroup>
              <col style={{ width: OV_W.bld }} />
              <col style={{ width: OV_W.room }} />
              <col style={{ width: OV_W.meal }} />
              {dates.map(d => <col key={d} style={{ width: dayW }} />)}
            </colgroup>
            <thead>
              <tr>
                <th colSpan={2} style={{ left: 0 }} className="rv-fix bg-gray-50 px-1 py-1 text-gray-500 font-semibold sticky top-0">部屋</th>
                <th style={{ left: OV_W.bld + OV_W.room }} className="rv-fix bg-gray-50 px-1 py-1 text-gray-500 font-semibold sticky top-0">食</th>
                {dates.map(d => {
                  const w = dowOf(year, month, d);
                  const isToday = isoOf(year, month, d) === today;
                  return (
                    <th key={d} className={`px-0.5 py-1 font-semibold sticky top-0 z-10 print:static ${dowColor(w)} ${isToday ? 'bg-emerald-100' : dowBg(w) || 'bg-gray-50'}`}>
                      <div>{d}</div><div className="text-[9px] font-normal">{w}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {buildings.map(b => (
                <Fragment key={b.name}>
                  {b.rooms.map((rm, ri) => {
                    const roomKey = `${b.name}-${rm.room}`;
                    const cells = mealGrid.get(roomKey) ?? [];
                    const isLastRoom = ri === b.rooms.length - 1;
                    return (
                      <Fragment key={roomKey}>
                        {MEAL_ROWS.map((mr, mi) => (
                          <tr key={mr.key}
                            className={`rv-mealrow ${mi === MEAL_ROWS.length - 1 ? 'rv-roomend' : ''} ${
                              mi === MEAL_ROWS.length - 1 && isLastRoom && b.staging ? 'rv-bldend' : ''}`}>
                            {ri === 0 && mi === 0 && (
                              <th rowSpan={b.rooms.length * MEAL_ROWS.length} style={{ left: 0 }}
                                className={`rv-fix px-1 py-1 text-[10px] font-bold ${
                                  b.staging ? 'bg-slate-200 text-slate-700'
                                    : b.name === 'さくら' ? 'bg-rose-50 text-rose-700' : 'bg-purple-50 text-purple-700'}`}>{b.name}</th>
                            )}
                            {mi === 0 && (
                              <th rowSpan={MEAL_ROWS.length} style={{ left: OV_W.bld }}
                                className={`rv-fix px-1 py-1 font-bold rv-roomend ${
                                  rm.disabled ? 'bg-gray-100 text-gray-300'
                                    : rm.staging ? 'bg-slate-100 text-slate-600' : 'bg-white text-gray-600'}`}>{pad2(rm.room)}</th>
                            )}
                            <td style={{ left: OV_W.bld + OV_W.room }}
                              className="rv-fix px-0.5 py-0 text-[10px] text-gray-500 bg-gray-50">{mr.label}</td>

                            {dates.map((_, i) => {
                              const iso = isoOf(year, month, i + 1);
                              const w = dowOf(year, month, i + 1);
                              const cell = cells[i]?.[mi] ?? { eaters: [] as Reservation[] };
                              const eater = cell.eaters[0];
                              const stay = cell.stay;                 // 在室だがこの食事はない人
                              const shown = eater ?? stay;

                              const dupMeal = cell.eaters.length > 1;  // 同じ部屋の同じ食事に2人＝二重予約
                              const dupPerson = !!eater && doubleBooked.has(`${eater.name}|${iso}`);
                              const isSource = !!shown && !!drag && drag.rv.id === shown.id;
                              const inPreview = !!preview && preview.building === b.name && preview.room === rm.room
                                && iso >= preview.start && iso <= preview.end;

                              // 塊の枠：隣のマスと同じ人かどうかで辺を決める。
                              // 月をまたぐぶんや、同日交代で上下の人が変わるところも自然に囲える。
                              let blk = '';
                              if (shown) {
                                const same = (di: number, mj: number) => occAt(roomKey, di, mj)?.id === shown.id;
                                const top = mi === 0 || !same(i, mi - 1);
                                const bot = mi === MEAL_ROWS.length - 1 || !same(i, mi + 1);
                                const left = i === 0 ? shown.start === iso : !same(i - 1, mi);
                                const right = i === daysInMonth - 1 ? shown.end === iso : !same(i + 1, mi);
                                blk = `${top ? 'rv-t ' : ''}${bot ? 'rv-b ' : ''}${left ? 'rv-l ' : ''}${right ? 'rv-r ' : ''}`;
                              }

                              const isWend = w === '土' || w === '日';
                              const base = eater
                                ? (eater.status === '確定'
                                    ? `${mr.tint} text-gray-900` : 'bg-amber-50 text-amber-900 rv-kari')
                                : stay ? (isWend ? dowBg(w) : '') + ' rv-stay'
                                : (b.staging ? 'bg-slate-50 ' : '') + (dowBg(w) || '') + ' text-gray-300';
                              const warn = dupMeal ? 'outline outline-2 outline-red-500 '
                                : dupPerson ? 'outline outline-2 outline-red-400 bg-red-100 ' : '';
                              const dnd = inPreview ? 'outline outline-2 outline-sky-600 bg-sky-200 ' : '';

                              // 入所時刻は初日の朝マス、退所時刻は最終日の夕マスに出す。
                              // 食事ルール上そこは空くことが多いので、ちょうど収まる。
                              const timeHere = !eater && stay
                                ? (mi === 0 && stay.start === iso && stay.inTime ? timeLabel(stay, stay.inTime)
                                  : mi === MEAL_ROWS.length - 1 && stay.end === iso && stay.outTime ? timeLabel(stay, stay.outTime)
                                  : '')
                                : '';

                              const title = shown
                                ? `${shown.name}（${shown.status}）${b.name}${pad2(rm.room)}号 ${shown.start}〜${shown.end}`
                                  + (shown.inTime ? ` / 入所 ${shown.inTime}` : '') + (shown.outTime ? ` / 退所 ${shown.outTime}` : '')
                                  + (shown.soutai ? ` / ${shown.soutai}` : '') + (shown.note ? ` / ${shown.note}` : '')
                                  + (eater ? '' : `　※${mr.label}食はありません`)
                                  + (dupMeal ? `　※この${mr.label}に${cell.eaters.length}人が重なっています` : '')
                                  + (dupPerson ? '　※同じ人が同じ日に別の部屋にも入っています' : '')
                                : `${mdOf(iso)} ${mr.label} 空き`;

                              return (
                                <td key={i} title={title}
                                  draggable={!!shown && !busy}
                                  onDragStart={shown ? e => onDragStart(e, shown, i) : undefined}
                                  onDragEnd={clearDrag}
                                  onDragOver={e => onDragOver(e, b.name, rm.room, i)}
                                  onDrop={e => onDrop(e, b.name, rm.room, i)}
                                  onClick={() => shown ? openEdit(shown) : openNew(b.name, rm.room, iso)}
                                  className={`px-0 py-0 cursor-pointer hover:outline hover:outline-2 hover:outline-sky-400 ${
                                    shown ? 'rv-grab ' : ''}${isSource ? 'opacity-40 ' : ''}${dnd}${warn}${blk}${base}`}>
                                  {timeHere
                                    ? <span className="rv-time">{timeHere}</span>
                                    : shown
                                      ? <span className="rv-name" style={{ fontSize: fontPxFor(shown.name, dayW) }}>{shown.name}</span>
                                      : '・'}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                  {/* 棟ごとの利用者数（食事管理アプリの全体一覧と同じ見せ方） */}
                  {!b.staging && (
                    <tr className="rv-bldend">
                      <th colSpan={3} style={{ left: 0 }}
                        className={`rv-fix px-1 py-1 text-[10px] font-bold ${
                          b.name === 'さくら' ? 'bg-rose-100 text-rose-800' : 'bg-purple-100 text-purple-800'}`}>
                        {b.name} 計
                      </th>
                      {(countsPerBuilding.get(b.name) ?? []).map((c, i) => {
                        const w = dowOf(year, month, i + 1);
                        const full = c >= b.rooms.filter(r => !r.disabled).length;
                        return (
                          <td key={i} title={`${mdOf(isoOf(year, month, i + 1))} ${b.name} ${c}名`}
                            className={`px-0.5 py-1 text-[11px] font-bold ${dowBg(w) || 'bg-gray-50'} ${
                              !c ? 'text-gray-300' : full ? 'text-red-600' : 'text-emerald-700'}`}>
                            {c || ''}
                          </td>
                        );
                      })}
                    </tr>
                  )}
                </Fragment>
              ))}
              {/* その日の空き部屋数（仮置きは数えない） */}
              <tr>
                <th colSpan={3} style={{ left: 0 }} className="rv-fix bg-gray-50 px-1 py-1 text-[10px] text-gray-600 font-bold">空き</th>
                {vacantPerDay.map((n, i) => (
                  <td key={i} className={`px-0.5 py-1 text-[11px] font-bold bg-gray-50 ${n === 0 ? 'text-red-600' : n <= 3 ? 'text-amber-600' : 'text-gray-400'}`}>{n}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* この月の予約一覧 */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-3 py-2 font-bold text-sm bg-gray-50 border-b border-gray-200">
          {year}年{month}月にかかる予約（{rows.length}件）
          <span className="ml-2 font-normal text-xs text-gray-400">あいうえお順</span>
        </div>
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-sm text-gray-400">この月の予約はまだありません。</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 bg-gray-50">
                <th className="px-3 py-1.5">氏名</th><th className="px-2 py-1.5">部屋</th>
                <th className="px-2 py-1.5">期間</th><th className="px-2 py-1.5">泊</th>
                <th className="px-2 py-1.5">状態</th>
                <th className="px-2 py-1.5">入所</th><th className="px-2 py-1.5">退所</th>
                <th className="px-2 py-1.5">送迎</th>
                <th className="px-2 py-1.5">備考</th><th className="rv-noprint px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {listRows.map(r => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 font-medium text-gray-800">{r.name}</td>
                  <td className="px-2 py-1.5 text-gray-600">{r.building}{pad2(r.room)}</td>
                  <td className="px-2 py-1.5 text-gray-600 tabular-nums">{r.start} 〜 {r.end}</td>
                  <td className="px-2 py-1.5 text-gray-500 tabular-nums">{nightsOf(r.start, r.end)}</td>
                  <td className="px-2 py-1.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${r.status === '確定' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{r.status}</span>
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-600 tabular-nums">{r.inTime}</td>
                  <td className="px-2 py-1.5 text-xs text-gray-600 tabular-nums">{r.outTime}</td>
                  <td className="px-2 py-1.5 text-xs">
                    {r.soutai === '家族送迎'
                      ? <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-bold">FA 家族送迎</span>
                      : r.soutai === '送迎あり'
                        ? <span className="text-gray-600">送迎あり</span>
                        : ''}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-500">{r.note}</td>
                  <td className="rv-noprint px-2 py-1.5">
                    <button onClick={() => openEdit(r)} className="text-sky-600 underline text-xs">編集</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="rv-noprint text-xs text-gray-400">
        ※ <b>予約のマスはつまんで動かせます</b>（部屋替えと日付ずらしが同時にできます。塊ごと動き、泊数は変わりません）。
        動かす先が埋まっているときは確認してから動かします。入れ替えたいときは、先に片方を<b>「仮置き」</b>へ逃がしてください
        （仮置きは実在しない部屋なので、空き部屋数や空き検索には出ません）。
        移動は「↩ 直前の移動を戻す」、削除は「↩ 削除を取り消す」で、それぞれ直前の1回を取り消せます。
        <b>消した予約は「削除ログ」シートに残る</b>ので、あとから気づいたときも「🗑 削除の履歴」からいつでも戻せます
        （消したときと同じ内容・同じ行で戻ります）。
        空きマスをクリックで追加、予約のマスをクリックで編集。期間を入れると、その期間を丸ごと押さえられる部屋が選択肢に「○」で出ます。
        入所時間は初日の名前の上、退所時間は最終日の名前の下に出ます。<b>家族送迎</b>のときは時間の前に <b>FA</b> が付きます
        （時間の入力は送迎の有無とは別で、送迎なしでも入れられます）。
        ※ タッチ操作ではドラッグできないので、その場合は編集フォームで部屋と期間を直してください。
      </p>
    </div>
  );
}
