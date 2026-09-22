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
import { classifyOverlap } from '@/lib/overlap';

type SoutaiKind = '' | '送迎あり' | '家族送迎';

interface Reservation {
  id: string;
  name: string;
  building: string;
  room: number;
  start: string;
  end: string;
  status: '仮予約' | '確定';
  inTime: string;          // 入所時間（初日）
  soutaiIn: SoutaiKind;    // 入所時の送迎
  outTime: string;         // 退所時間（最終日）
  soutaiOut: SoutaiKind;   // 退所時の送迎
  note: string;
  createdAt: string;
}

/** 家族送迎は時間の前に「FA」を付けて出す。送迎は入所・退所で別なので、その向きのほうを見る。 */
const timeLabel = (s: SoutaiKind, t: string) => (s === '家族送迎' ? `FA ${t}` : t);
/** 一覧表で時刻のうしろに出す送迎の印。 */
function SoutaiBadge({ s }: { s: SoutaiKind }) {
  if (s === '家族送迎') return <span className="px-1 py-0.5 rounded bg-slate-200 text-slate-700 font-bold">FA</span>;
  if (s === '送迎あり') return <span className="px-1 py-0.5 rounded bg-sky-100 text-sky-800">送迎</span>;
  return null;
}
interface Room { building: string; room: number; disabled: boolean; staging: boolean; note: string; }
interface Conflict {
  kind: 'room' | 'handover' | 'person';
  other: Reservation;
  days: string[];
  detail?: { outName: string; outTime: string; inName: string; inTime: string; day: string };
}
interface Vacancy {
  building: string; room: number; free: boolean;
  takenBy?: { name: string; start: string; end: string; status: string }[];
}

// A3横（余白6mm）の印刷できる範囲。1mm = 96/25.4 px。
const PRINT_W = 1542, PRINT_H = 1077;

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
 * チャートに出す氏名は姓名の間の空白を詰める。
 * 隣のマスとの間隔が狭いので、空白があるとマスの切れ目と見間違える。
 * （データ・一覧・ツールチップは元の表記のまま）
 */
const tightName = (s: string) => String(s ?? '').replace(/[\s　]+/g, '');

/**
 * 列幅に収まる文字サイズ。1部屋3行（朝昼夕）にしたので氏名は1行で出す。
 * 食事管理アプリの全体一覧と同じ考え方＝列幅 ÷ 文字数。
 * 画面が広いほど列が広がり、自動的に文字も大きくなる。
 */
function fontPxFor(s: string, dayW: number): number {
  const n = Math.max(1, tightName(s).length);
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

const HOUR_OPTS = Array.from({ length: 24 }, (_, i) => pad2(i));
const MIN_OPTS = Array.from({ length: 12 }, (_, i) => pad2(i * 5));   // 00,05,…,55

/**
 * 時刻の入力欄。「時」と「分」のプルダウン2つに分ける。
 * type="time" だと分が1分刻みで出てしまい、現場では選びにくいため。
 * 分は5分刻み。時を選んだときに分が空なら 00 を入れる。
 */
function TimeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(value ?? '').trim());
  const h = m ? pad2(Number(m[1])) : '';
  // シートに5分刻みでない値が入っていても、いちばん近い選択肢を出す
  const mi = m ? pad2(Math.min(55, Math.round(Number(m[2]) / 5) * 5)) : '';
  const sel = 'border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white';
  return (
    <span className="inline-flex items-center gap-1">
      <select value={h} className={sel}
        onChange={e => onChange(e.target.value ? `${e.target.value}:${mi || '00'}` : '')}>
        <option value="">--</option>
        {HOUR_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <span className="text-gray-400">:</span>
      <select value={mi} disabled={!h} className={`${sel} ${h ? '' : 'opacity-40'}`}
        onChange={e => onChange(`${h}:${e.target.value}`)}>
        {!h && <option value="">--</option>}
        {MIN_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </span>
  );
}

/** 重なり1件ぶんの説明。保存前の確認と移動の確認で同じ文言を使う。 */
function ConflictLine({ c }: { c: Conflict }) {
  const span = `${mdOf(c.days[0])}〜${mdOf(c.days[c.days.length - 1])}`;
  if (c.kind === 'handover' && c.detail) {
    const d = c.detail;
    const unknown = !d.outTime || !d.inTime;
    return (
      <>
        <b className={unknown ? 'text-amber-800' : 'text-red-700'}>
          {unknown ? '入れ替わりの時刻が確かめられません' : '入れ替わりの時刻が合いません'}
        </b>
        ：{mdOf(d.day)} に <b>{d.outName}</b> さんが退所 {d.outTime || '（時刻未入力）'}、
        <b>{d.inName}</b> さんが入所 {d.inTime || '（時刻未入力）'}
        {unknown ? '（どちらかの時刻を入れると判定できます）' : '（前の人が出る前に次の人が入ります）'}
      </>
    );
  }
  if (c.kind === 'room') {
    return <>同じ部屋（{c.other.building}{pad2(c.other.room)}号）に <b>{c.other.name}</b> さんの{c.other.status}：{span}</>;
  }
  return <><b className="text-red-700">同じ人を別の部屋にも</b>：{c.other.name} さんは {c.other.building}{pad2(c.other.room)}号 にも{c.other.status}（{span}）</>;
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
  inTime: string;
  soutaiIn: SoutaiKind;
  outTime: string;
  soutaiOut: SoutaiKind;
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
  start: string; end: string; status: '仮予約' | '確定';
  inTime: string; soutaiIn: SoutaiKind; outTime: string; soutaiOut: SoutaiKind; note: string;
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
  /**
   * 氏名の出し方。現場と相談中のため画面で切り替えられるようにしてある（2026-09-22）。
   *   every … 滞在している日すべてに出す
   *   once  … 塊に1回だけ中央に大きく出す（ガントチャート流。既定）
   * 選んだほうはこの端末に覚えておく。
   * 既定を once にした際にキー名を変えてある（前に毎日を選んだ端末でも、まず once で見えるように）。
   */
  const [nameMode, setNameMode] = useState<'every' | 'once'>('once');
  useEffect(() => {
    try {
      const v = localStorage.getItem('rv-name-mode2');
      if (v === 'once' || v === 'every') setNameMode(v);
    } catch { /* 保存できない環境では既定のまま */ }
  }, []);
  const changeNameMode = (v: 'every' | 'once') => {
    setNameMode(v);
    try { localStorage.setItem('rv-name-mode2', v); } catch { /* 保存できなくても表示は変わる */ }
  };

  /**
   * 印刷は台帳（A3横）と予約一覧（A4縦）で紙が違うので、ボタンも別にして押したほうだけ刷る。
   * 用紙の指定は CSS の @page で、状態が画面に反映されてから印刷を呼ぶ必要がある（nonce で1拍おく）。
   */
  const [printWhat, setPrintWhat] = useState<'chart' | 'list'>('chart');
  const [printNonce, setPrintNonce] = useState(0);
  const doPrint = (what: 'chart' | 'list') => { setPrintWhat(what); setPrintNonce(n => n + 1); };
  useEffect(() => {
    if (!printNonce) return;
    const t = setTimeout(() => window.print(), 80);
    return () => clearTimeout(t);
  }, [printNonce]);

  // 表を置ける幅（列幅を画面いっぱいに広げるため。食事管理アプリの全体一覧と同じ）
  const bodyRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLTableElement>(null);
  const [availW, setAvailW] = useState(0);
  // 表の高さ（部屋数で決まる。日数を減らしても縮まない）。A3に収める縮小率を出すのに使う。
  const [chartH, setChartH] = useState(0);
  useEffect(() => {
    const measure = () => {
      if (bodyRef.current) setAvailW(bodyRef.current.clientWidth);
      if (chartRef.current) setChartH(chartRef.current.offsetHeight);
    };
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
   * 食事の無いマスは空。その時間帯その部屋は空いていて次の人を受け入れられるため、
   * 在室していても名前は出さない（枠もそのぶん欠ける）。
   * time   = そのマスに出す入退所時刻。名前が入らないマスにだけ置く。
   */
  interface MealCell {
    eaters: Reservation[];
    time?: string; timeOf?: Reservation;
    /** 入所の時刻か退所の時刻か。マスの中で寄せる向きを変えて、どの塊のものか分かるようにする。 */
    timeKind?: 'in' | 'out';
    /** 空きマスが無くて、名前と同じマスに時刻を並べる場合（夕食まで食べて退所するときなど） */
    timeWithName?: boolean;
    /**
     * 氏名を出すマス。塊ごとに1つだけ決めて、そこにまとめて大きく出す。
     * offCells は塊の中心とこのマスの中心のずれ（マス数）。偶数日数の塊で半マスずれるぶんを補正する。
     */
    label?: { rv: Reservation; runLen: number; offCells: number };
  }
  const mealGrid = useMemo(() => {
    const map = new Map<string, MealCell[][]>();
    for (const r of rooms) {
      const key = `${r.building}-${r.room}`;
      const cells = grid.get(key) ?? [];
      const days: MealCell[][] = Array.from({ length: daysInMonth }, (_, i) => {
        const iso = isoOf(year, month, i + 1);
        const list = cells[i] ?? [];
        const out: MealCell[] = MEAL_KEYS.map(mk => ({ eaters: list.filter(rv => mealsFor(rv, iso)[mk]) }));

        // 入所時刻は最初の食事の1つ上の行、退所時刻は最後の食事の1つ下の行に置く。
        // ちょうど食事が無くて空いている行なので、名前とぶつからない。
        // 空きマスがあればそこへ。無ければ（例：夕食まで食べて退所する日）
        // 端の食事マスに名前と並べて出す。出し損ねると時刻がどこにも出なくなるため。
        const putTime = (rv: Reservation, text: string, prefer: number, fallback: number, kind: 'in' | 'out') => {
          if (prefer >= 0 && prefer < MEAL_KEYS.length && !out[prefer].eaters.length && !out[prefer].time) {
            out[prefer].time = text; out[prefer].timeOf = rv; out[prefer].timeKind = kind; return;
          }
          if (fallback >= 0 && fallback < MEAL_KEYS.length && !out[fallback].time) {
            out[fallback].time = text; out[fallback].timeOf = rv; out[fallback].timeKind = kind;
            out[fallback].timeWithName = true;
          }
        };
        for (const rv of list) {
          const m = mealsFor(rv, iso);
          const eaten = MEAL_KEYS.map((k, mi) => (m[k] ? mi : -1)).filter(x => x >= 0);
          if (iso === rv.start && rv.inTime) {
            const first = eaten.length ? eaten[0] : MEAL_KEYS.length - 1;
            putTime(rv, timeLabel(rv.soutaiIn, rv.inTime), first - 1, first, 'in');
          }
          if (iso === rv.end && rv.outTime) {
            const last = eaten.length ? eaten[eaten.length - 1] : 0;
            putTime(rv, timeLabel(rv.soutaiOut, rv.outTime), last + 1, last, 'out');
          }
        }
        return out;
      });

      // 氏名は塊に1回だけ。行ごとに連続している範囲を拾い、
      // 昼 → 夕 → 朝 の順でいちばん長い行を選んで、その真ん中のマスに出す。
      // 名前の繰り返しが消えるぶん、文字を大きくできる。
      const runs = new Map<string, { rv: Reservation; row: number; s: number; e: number }[]>();
      for (let mi = 0; mi < MEAL_KEYS.length; mi++) {
        let i = 0;
        while (i < daysInMonth) {
          const rv = days[i][mi].eaters[0];
          if (!rv) { i++; continue; }
          let j = i;
          while (j + 1 < daysInMonth && days[j + 1][mi].eaters[0]?.id === rv.id) j++;
          if (!runs.has(rv.id)) runs.set(rv.id, []);
          runs.get(rv.id)!.push({ rv, row: mi, s: i, e: j });
          i = j + 1;
        }
      }
      type Run = { rv: Reservation; row: number; s: number; e: number };
      /** 上下に隣り合って重なっていれば、同じひとかたまり。斜めだけの接触はつながりと見ない。 */
      const touches = (a: Run, b: Run) => Math.abs(a.row - b.row) === 1 && a.s <= b.e && b.s <= a.e;
      for (const seen of runs.values()) {
        // 同じ予約でも、食事の無い時間帯で分断されて離れ小島になることがある。
        // 例）1泊2日で16:00入所・09:00退所＝初日の夕と二日目の朝だけ。斜めに離れて枠が2つに割れ、
        //     別の予約に見えてしまう。そこで「氏名は塊に1回」は、離れたかたまりごとに1回とする。
        const groups: Run[][] = [];
        const taken = new Array(seen.length).fill(false);
        for (let i = 0; i < seen.length; i++) {
          if (taken[i]) continue;
          const g = [seen[i]];
          taken[i] = true;
          for (let k = 0; k < g.length; k++) {
            for (let j = 0; j < seen.length; j++) {
              if (!taken[j] && touches(g[k], seen[j])) { taken[j] = true; g.push(seen[j]); }
            }
          }
          groups.push(g);
        }

        for (const g of groups) {
          let best: Run | undefined;
          for (const pref of [1, 2, 0]) {                       // 昼・夕・朝
            const cand = g.filter(x => x.row === pref).sort((a, b) => (b.e - b.s) - (a.e - a.s))[0];
            if (cand) { best = cand; break; }
          }
          if (!best) continue;
          const mid = Math.floor((best.s + best.e) / 2);
          days[mid][best.row].label = {
            rv: best.rv, runLen: best.e - best.s + 1,
            offCells: (best.s + best.e) / 2 - mid,
          };
        }
      }

      map.set(key, days);
    }
    return map;
  }, [grid, rooms, daysInMonth, year, month]);

  /** そのマスで食事をする人。塊の枠はこれを基準に描くので、食事の無いマスは枠から外れる。 */
  const occAt = useCallback((roomKey: string, dayIdx: number, mealIdx: number): Reservation | undefined =>
    mealGrid.get(roomKey)?.[dayIdx]?.[mealIdx]?.eaters[0], [mealGrid]);

  /**
   * 時刻が合わない同日交代。
   * 例）さくら01 を 11:00 に退所する人がいる日に、10:00 入所の人を入れると重なる。
   * 食事は 朝＝前の人／昼夕＝次の人 と分かれてしまうので食事のマスだけでは気づけない。
   * 部屋＋日付で持ち、その日の3行すべてを赤くする。
   */
  const timeClash = useMemo(() => {
    const byRoom = new Map<string, Reservation[]>();
    for (const rv of rows) {
      const k = `${rv.building}-${rv.room}`;
      if (!byRoom.has(k)) byRoom.set(k, []);
      byRoom.get(k)!.push(rv);
    }
    const bad = new Map<string, { day: string; outName: string; outTime: string; inName: string; inTime: string; unknown: boolean }>();
    for (const [k, list] of byRoom) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const res = classifyOverlap(list[i], list[j]);
          if (res.kind !== 'handover-clash' && res.kind !== 'handover-unknown') continue;
          const h = res.handover!;
          bad.set(`${k}|${h.day}`, {
            day: h.day,
            outName: (h.out as Reservation).name, outTime: h.outTime,
            inName: (h.in as Reservation).name, inTime: h.inTime,
            unknown: res.kind === 'handover-unknown',
          });
        }
      }
    }
    return bad;
  }, [rows]);

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
      status: '仮予約', inTime: '09:00', soutaiIn: '', outTime: '16:00', soutaiOut: '', note: '',
    });
    setConflicts(null); setMsg('');
  };
  const openEdit = (rv: Reservation) => {
    setForm({
      id: rv.id, name: rv.name, building: rv.building, room: rv.room,
      start: rv.start, end: rv.end, status: rv.status,
      inTime: rv.inTime, soutaiIn: rv.soutaiIn, outTime: rv.outTime, soutaiOut: rv.soutaiOut, note: rv.note,
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
          inTime: rv.inTime, soutaiIn: rv.soutaiIn, outTime: rv.outTime, soutaiOut: rv.soutaiOut, note: rv.note,
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
  // 出す日付（1始まりの日）。マス目そのものは月ぜんぶ持っているので、ここは「どこを見せるか」だけ。
  const dates = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const today = todayISO();
  const formNights = form ? nightsOf(form.start, form.end) : 0;
  const freeList = vacancy?.vacancies.filter(v => v.free) ?? [];

  // 日付列の幅＝画面の空き幅を日数で割って広げる（狭い画面では DAY_MIN で横スクロール）
  const fixedW = OV_W.bld + OV_W.room + OV_W.meal;
  const dayW = Math.max(DAY_MIN, Math.floor(((availW || 0) - fixedW) / (dates.length || 1)) || 0);

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

  // 紙は A3横1枚。部屋数ぶんの高さははみ出しがちなので、その分だけ全体を縮める。
  // 横は縮めたあとにちょうど紙幅になるよう、先に広げた幅を入れておく。
  const printChart = printWhat === 'chart';
  const printBody = PRINT_H - 44;   // 見出し1行ぶんを空けておく
  const printZoom = chartH > printBody ? Math.max(0.5, Math.floor((printBody / chartH) * 100) / 100) : 1;
  const printTableW = Math.round((PRINT_W - 2) / printZoom);

  return (
    <div className="rv-print space-y-4">
      <style>{`
        @media print {
          /* 台帳（A3横1枚）と一覧（A4縦）は別々に刷る。押したボタンで用紙ごと切り替える。 */
          @page { size: ${printChart ? 'A3 landscape' : 'A4 portrait'}; margin: ${printChart ? '6mm' : '10mm'}; }
          body * { visibility: hidden !important; }
          .rv-print, .rv-print * { visibility: visible !important; }
          .rv-print { position: absolute; left: 0; top: 0; width: 100%; }
          .rv-noprint, .rsv-noprint { display: none !important; }
          .rv-scroll { overflow: visible !important; max-height: none !important; }
          .rv-fix { position: static !important; }
          /* 画面用の行間は紙では無駄になるので詰める */
          .rv-print > * + * { margin-top: 2px !important; }
          /* 押していないほうは紙に出さない */
          ${printChart ? '.rv-list' : '.rv-chart'} { display: none !important; }

          /* 表だけを1枚に収める。ズームなので行が紙の途中で切れない。 */
          .rv-chart { zoom: ${printZoom}; }
          .rv-chart .rv-table { width: ${printTableW}px !important; }
          .rv-chart, .rv-list { border: 0 !important; box-shadow: none !important; border-radius: 0 !important; }

          /* 予約一覧（A4縦）。現場の見やすさ優先で14pt。日付は月日だけにして幅を詰める。 */
          .rv-list table { font-size: 14pt; width: 100% !important; }
          .rv-list thead { display: table-header-group; }   /* 2枚目以降にも見出しを出す */
          .rv-list tr { break-inside: avoid; page-break-inside: avoid; }
          .rv-list th, .rv-list td {
            padding: 2px 4px !important; color: #000 !important;
            font-size: inherit !important; white-space: nowrap;
          }
          .rv-list thead th { font-size: 11pt !important; border-bottom: 1px solid #666 !important; }

          /* ── 白黒印刷用の塗り ──────────────────────────────
             ① 背景は既定では刷られないので exact を付けて必ず出す
             ② 画面の淡い色は刷るとほぼ白で、埋まっている感じが出ない
             ③ 色ではなく「濃さ」と「模様」で確定と仮予約を分ける          */
          .rv-print, .rv-print * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          /* いちど全部を白に戻してから敷き直す（画面の淡い色が灰色に化けるのを防ぐ） */
          .rv-table th, .rv-table td {
            background: #fff !important; background-image: none !important;
            color: #000 !important; border-color: #e3e3e3 !important;
          }
          .rv-table td.rv-occ { background: #d5d5d5 !important; }            /* 確定＝ベタ塗り */
          .rv-table td.rv-kari {                                              /* 仮予約＝斜線 */
            background-image: repeating-linear-gradient(45deg, #9b9b9b 0 2px, #fff 2px 7px) !important;
          }
          .rv-table td.rv-empty.rv-we { background: #f4f4f4 !important; }     /* 土日の空きだけ薄く */
          .rv-table td.rv-empty { color: transparent !important; }            /* 空きマスの「・」は消す */
          .rv-table .rv-time { color: #000 !important; }
          .rv-table th.rv-dayhead { background: #ededed !important; }
          .rv-table th.rv-dayhead.rv-we { background: #d4d4d4 !important; }
          .rv-table tbody tr.rv-daterow th { border-top-color: #4a4a4a !important; border-bottom-color: #9a9a9a !important; }
          .rv-table tbody tr.rv-sum td, .rv-table tbody tr.rv-sum th { background: #ededed !important; }
          /* 部屋と棟の区切りは紙でも分かる濃さに */
          .rv-table tbody tr.rv-roomend td, .rv-table tbody tr.rv-roomend th { border-bottom-color: #9a9a9a !important; }
          .rv-table tbody tr.rv-bldend td, .rv-table tbody tr.rv-bldend th { border-bottom-color: #4a4a4a !important; }
          /* 一覧のほうは文字で読むので、状態や送迎の色札は外して黒文字にする */
          .rv-list span { background: none !important; color: #000 !important; padding: 0 2px !important; font-size: inherit !important; }
          .rv-list tbody tr { border-top-color: #bbb !important; }
        }
        /* 紙の見出しに出す凡例。画面では見出しごと隠れている。 */
        .rv-lg { display: inline-block; width: 15px; height: 10px; border: 1px solid #555; vertical-align: -1px; }
        .rv-lg-occ { background: #d5d5d5; }
        .rv-lg-kari { background-image: repeating-linear-gradient(45deg, #9b9b9b 0 2px, #fff 2px 7px); }
        .rv-table { border-collapse: collapse; table-layout: fixed; }
        /* 朝昼夕の間は縦線と同じ薄さ。部屋と部屋の区切りだけを太くして見分ける。 */
        .rv-table th, .rv-table td {
          border: 1px solid #eef1f5;
          white-space: nowrap; text-align: center; overflow: hidden;
        }
        .rv-table tbody tr.rv-bldend td, .rv-table tbody tr.rv-bldend th { border-bottom: 3px solid #94a3b8; }
        /* 棟の間に入れる日付行。上下を太めに区切って、表の途中でも日付だと分かるようにする。 */
        .rv-table tbody tr.rv-daterow th { border-top: 3px solid #94a3b8; border-bottom: 2px solid #cbd5e1; height: 16px; }
        /* 部屋の区切り（朝昼夕の3行が1部屋） */
        .rv-table tbody tr.rv-roomend td, .rv-table tbody tr.rv-roomend th { border-bottom: 2px solid #cbd5e1; }
        /* 予約の塊を枠で囲う。border-collapse と喧嘩しないよう内側の影で描く。
           隣のマスと同じ人かどうかで辺を出し分けるので、月またぎや同日交代も自然に囲える。 */
        /* 既定値は var() のフォールバックで持つ。td 側に --bt などを書いてしまうと
           そちらの詳細度が勝って .rv-t が効かなくなる（枠が出なくなる）。 */
        .rv-table td {
          box-shadow: var(--bt, 0 0 #0000), var(--bb, 0 0 #0000), var(--bl, 0 0 #0000), var(--br, 0 0 #0000);
        }
        .rv-t { --bt: inset 0 2px 0 #1e293b; }
        .rv-b { --bb: inset 0 -2px 0 #1e293b; }
        .rv-l { --bl: inset 2px 0 0 #1e293b; }
        .rv-r { --br: inset -2px 0 0 #1e293b; }
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
        /* 時刻は8pxだと年配の職員に読みにくいので12pxにしてある（1.5倍・2026-09-22 現場の声）。
           マスは幅54px・高さ18pxなので、"FA 09:00" でもこの大きさまでなら収まる。 */
        .rv-time { font-size: 12px; line-height: 1; letter-spacing: -.04em; color: #475569; font-weight: 400; }
        /* 名前と同じマスに並べるときだけは、名前がつぶれないよう少し小さくする */
        .rv-both .rv-time { font-size: 10px; }
        /* 時刻はそれぞれの塊のほうへ寄せる。入所は右下（これから始まる塊は右下へ伸びる）、
           退所は左上（終わる塊は左上から来ている）。どちらの塊の時刻か迷わなくなる。
           ⚠️ マス側の字と行間も詰めること。行ボックスがマスいっぱいのままだと縦の寄せが効かない。 */
        .rv-table td.rv-tin, .rv-table td.rv-tout { font-size: 12px; line-height: 1; }
        .rv-table td.rv-tin  { text-align: right; vertical-align: bottom; padding: 0 1px 1px 0; }
        .rv-table td.rv-tout { text-align: left;  vertical-align: top;    padding: 1px 0 0 1px; }
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
        /* 氏名は塊に1回だけ。そのマスだけ枠外へはみ出させ、塊の幅で中央に置く。
           はみ出す先は同じ塊の（名前を出さない）マスなので、隣の予約を隠さない。 */
        .rv-table td.rv-haslabel { overflow: visible; position: relative; z-index: 3; }
        /* 名前と時刻を1マスに並べるとき（夕食まで食べて退所する日など） */
        .rv-both { display: flex; align-items: center; justify-content: center; gap: 2px; width: 100%; }
        .rv-blockname {
          position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
          white-space: nowrap; overflow: hidden; text-align: center; line-height: 1;
          pointer-events: none;   /* クリックやホバーは下のマスに通す */
        }
      `}</style>

      {/* 紙に出るときだけの見出し。貼り出したときに何の表か分かるようにする。 */}
      <div className="hidden print:block mb-1">
        {printChart ? (
          <>
            <span className="text-base font-bold">
              グラン悠遊　ショート予約台帳　{year}年{month}月
            </span>
            <span className="ml-4 text-[10px] font-normal text-gray-600">
              <span className="rv-lg rv-lg-occ" /> 確定 {rows.filter(r => r.status === '確定').length}件
              　<span className="rv-lg rv-lg-kari" /> 仮予約 {rows.filter(r => r.status === '仮予約').length}件
              {occupancy && `　稼働率 ${occupancy.pct}%`}　印刷 {today}
            </span>
          </>
        ) : (
          <span className="text-base font-bold">
            グラン悠遊　ショート予約一覧　{year}年{month}月（{rows.length}件・あいうえお順）
            <span className="ml-3 text-[10px] font-normal text-gray-600">印刷 {today}</span>
          </span>
        )}
      </div>

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
        {/* 氏名の出し方。毎日と塊に1回を両方使うので、切り替えは残す（2026-09-22 現場の結論） */}
        <span className="inline-flex items-center rounded-lg bg-gray-100 p-0.5 text-xs"
          title="チャートに氏名をどう出すか。現場で見比べて決めてください。">
          <span className="px-1.5 text-gray-500">氏名</span>
          {([['every', '毎日'], ['once', '塊に1回']] as const).map(([v, label]) => (
            <button key={v} onClick={() => changeNameMode(v)}
              className={`px-2 py-1 rounded-md font-semibold ${
                nameMode === v ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>
              {label}
            </button>
          ))}
        </span>
        <button onClick={() => { const open = !trashOpen; setTrashOpen(open); if (open) loadTrash(); }}
          className={`rounded-lg px-3 py-2 text-sm font-semibold ${trashOpen ? 'bg-slate-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`}>
          🗑 削除の履歴
        </button>
        <button onClick={() => doPrint('chart')} className="bg-sky-500 text-white rounded-lg px-3 py-2 text-sm font-semibold hover:bg-sky-600">🖨 台帳を印刷（A3横）</button>
        <button onClick={() => doPrint('list')} className="bg-sky-100 text-sky-800 rounded-lg px-3 py-2 text-sm font-semibold hover:bg-sky-200">🖨 一覧を印刷（A4縦）</button>
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
      {/* 時刻が合わない同日交代。食事のマスだけでは気づけないので、ここに一覧で出す。 */}
      {timeClash.size > 0 && (
        <div className="rv-noprint rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-800 space-y-1">
          <div className="font-bold">⚠ 同じ日の入れ替わりで時刻が合っていません（{timeClash.size}件）</div>
          <ul className="list-disc pl-5 max-h-32 overflow-y-auto">
            {[...timeClash.entries()].map(([k, c]) => (
              <li key={k} className={c.unknown ? 'text-amber-800' : ''}>
                {k.split('|')[0].replace('-', '')}号　{mdOf(c.day)}：
                <b>{c.outName}</b> さん退所 {c.outTime || '（時刻未入力）'} →{' '}
                <b>{c.inName}</b> さん入所 {c.inTime || '（時刻未入力）'}
                {c.unknown ? '（時刻が入っていないので確認できません）' : '（前の人が出る前に次の人が入ります）'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 書こうとしたら重なっていたときの確認（移動・削除の取り消しで共用） */}
      {ask && (
        <div className="rv-noprint rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 space-y-2">
          <div className="font-bold">⚠ {ask.title}</div>
          <ul className="list-disc pl-5 max-h-32 overflow-y-auto">
            {ask.conflicts.map((c, i) => (
              <li key={i}>
                <ConflictLine c={c} />
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
            {/* 時刻は「時」「分」のプルダウン。分は5分刻み。 */}
            <div className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">入所時間（初日）</span>
              <TimeSelect value={form.inTime} onChange={v => patch({ inTime: v })} />
            </div>
            {/* 送迎は入所と退所で違うことがあるので別々に選ぶ */}
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">入所の送迎</span>
              <select value={form.soutaiIn} onChange={e => patch({ soutaiIn: e.target.value as SoutaiKind })}
                className="border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white">
                <option value="">なし</option>
                <option value="送迎あり">送迎あり</option>
                <option value="家族送迎">家族送迎（FA）</option>
              </select>
            </label>
            <div className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">退所時間（最終日）</span>
              <TimeSelect value={form.outTime} onChange={v => patch({ outTime: v })} />
            </div>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">退所の送迎</span>
              <select value={form.soutaiOut} onChange={e => patch({ soutaiOut: e.target.value as SoutaiKind })}
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
          {(form.soutaiIn === '家族送迎' || form.soutaiOut === '家族送迎') && (
            <div className="text-xs text-slate-600">
              ※ 家族送迎は、表のその向きの時刻の前に <b>FA</b> と出ます
              （{form.soutaiIn === '家族送迎' ? '入所' : ''}{form.soutaiIn === '家族送迎' && form.soutaiOut === '家族送迎' ? '・' : ''}{form.soutaiOut === '家族送迎' ? '退所' : ''}）。
            </div>
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
                    <ConflictLine c={c} />
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
        <div ref={bodyRef} className="rv-chart rv-scroll bg-white rounded-xl border border-gray-100 shadow-sm overflow-auto max-h-[64vh] print:max-h-none"
             onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPreview(null); }}>
          <table ref={chartRef} className="rv-table text-[11px]" style={{ width: fixedW + dayW * dates.length }}>
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
                    <th key={d} className={`rv-dayhead ${w === '日' || w === '土' ? 'rv-we ' : ''}px-0.5 py-1 font-semibold sticky top-0 z-10 print:static ${dowColor(w)} ${isToday ? 'bg-emerald-100' : dowBg(w) || 'bg-gray-50'}`}>
                      <div>{d}</div><div className="text-[9px] font-normal">{w}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {(() => {
                /**
                 * 並び順（2026-09-22 現場の結論）
                 *   日付 → さくら計 → さくら → 日付 → 仮置き01 → すみれ計 → すみれ → 仮置き02 → 空き
                 * ・日付行を棟の間にも入れる（下のほうで日付を見失わないように）
                 * ・仮置きを棟の間にも置く（入れ替えのとき遠くまで運ばなくてよいように）
                 * ・棟の合計は日付行のすぐ下。一番下に置くと日付と見間違えるため。
                 */
                const realB = buildings.filter(b => !b.staging);
                const stagingB = buildings.find(b => b.staging);
                const stagingRooms = stagingB?.rooms ?? [];

                const bldTh = (name: string, staging: boolean, span: number) => (
                  <th rowSpan={span} style={{ left: 0 }}
                    className={`rv-fix px-1 py-1 text-[10px] font-bold ${
                      staging ? 'bg-slate-200 text-slate-700'
                        : name === 'さくら' ? 'bg-rose-50 text-rose-700' : 'bg-purple-50 text-purple-700'}`}>{name}</th>
                );

                /** 棟の間にも入れる日付行。見出しと同じ並びだが、こちらは動かない普通の行。 */
                const dateRow = (key: string) => (
                  <tr key={key} className="rv-daterow">
                    <th colSpan={3} style={{ left: 0 }}
                      className="rv-fix bg-gray-100 px-1 py-1 text-[10px] text-gray-500 font-semibold">日付</th>
                    {dates.map(d => {
                      const w = dowOf(year, month, d);
                      const isToday = isoOf(year, month, d) === today;
                      return (
                        <th key={d} className={`rv-dayhead ${w === '日' || w === '土' ? 'rv-we ' : ''}px-0.5 py-0.5 text-[10px] font-semibold ${
                          dowColor(w)} ${isToday ? 'bg-emerald-100' : dowBg(w) || 'bg-gray-100'}`}>{d}</th>
                      );
                    })}
                  </tr>
                );

                /** 棟ごとの利用者数。日付行のすぐ下に置く。 */
                const sumRow = (b: { name: string; rooms: Room[] }) => (
                  <tr key={`sum-${b.name}`} className="rv-sum">
                    <th colSpan={3} style={{ left: 0 }}
                      className={`rv-fix px-1 py-1 text-[10px] font-bold ${
                        b.name === 'さくら' ? 'bg-rose-100 text-rose-800' : 'bg-purple-100 text-purple-800'}`}>
                      {b.name} 計
                    </th>
                    {dates.map(d => {
                      const c = (countsPerBuilding.get(b.name) ?? [])[d - 1] ?? 0;
                      const w = dowOf(year, month, d);
                      const full = c >= b.rooms.filter(r => !r.disabled).length;
                      return (
                        <td key={d} title={`${mdOf(isoOf(year, month, d))} ${b.name} ${c}名`}
                          className={`px-0.5 py-1 text-[11px] font-bold ${dowBg(w) || 'bg-gray-50'} ${
                            !c ? 'text-gray-300' : full ? 'text-red-600' : 'text-emerald-700'}`}>
                          {c || ''}
                        </td>
                      );
                    })}
                  </tr>
                );

                /** 1部屋ぶん（朝昼夕の3行）。棟のどこに置いても同じように描けるように切り出してある。 */
                const roomRows = (
                  b: { name: string; staging: boolean },
                  rm: Room,
                  o: { bldSpan?: number; endsGroup?: boolean },
                ) => {
                    const roomKey = `${b.name}-${rm.room}`;
                    const cells = mealGrid.get(roomKey) ?? [];
                    return (
                      <Fragment key={roomKey}>
                        {MEAL_ROWS.map((mr, mi) => (
                          <tr key={mr.key}
                            className={`rv-mealrow ${mi === MEAL_ROWS.length - 1 ? 'rv-roomend' : ''} ${
                              mi === MEAL_ROWS.length - 1 && o.endsGroup ? 'rv-bldend' : ''}`}>
                            {o.bldSpan && mi === 0 && bldTh(b.name, b.staging, o.bldSpan)}
                            {mi === 0 && (
                              <th rowSpan={MEAL_ROWS.length} style={{ left: OV_W.bld }}
                                className={`rv-fix px-1 py-1 font-bold rv-roomend ${
                                  rm.disabled ? 'bg-gray-100 text-gray-300'
                                    : rm.staging ? 'bg-slate-100 text-slate-600' : 'bg-white text-gray-600'}`}>{pad2(rm.room)}</th>
                            )}
                            <td style={{ left: OV_W.bld + OV_W.room }}
                              className="rv-fix px-0.5 py-0 text-[10px] text-gray-500 bg-gray-50">{mr.label}</td>

                            {dates.map(d => {
                              const i = d - 1;                       // マス目は月ぜんぶぶんあるので、日から引く
                              const iso = isoOf(year, month, d);
                              const w = dowOf(year, month, d);
                              const cell = cells[i]?.[mi] ?? { eaters: [] as Reservation[] };
                              const eater = cell.eaters[0];
                              // 名前が出るのは食事のあるマスだけ。食事の無いマスは空＝次の人を入れられる。
                              const shown = eater;
                              // 入退所時刻。ふだんは食事の無い空きマスに出すが、
                              // 空きが無いとき（夕食まで食べて退所する日など）は名前と並べて出す。
                              const timeHere = (!eater || cell.timeWithName) ? (cell.time ?? '') : '';
                              const timeRv = !eater ? cell.timeOf : undefined;
                              // 時刻だけのマスは塊のほうへ寄せる（名前と同居するマスは中央のまま）
                              const timeAlign = timeHere && !eater
                                ? (cell.timeKind === 'in' ? 'rv-tin ' : 'rv-tout ') : '';

                              const dupMeal = cell.eaters.length > 1;  // 同じ部屋の同じ食事に2人＝二重予約
                              const dupPerson = !!eater && doubleBooked.has(`${eater.name}|${iso}`);
                              const clash = timeClash.get(`${b.name}-${rm.room}|${iso}`);  // 時刻の合わない交代
                              const isSource = !!shown && !!drag && drag.rv.id === shown.id;
                              const inPreview = !!preview && preview.building === b.name && preview.room === rm.room
                                && iso >= preview.start && iso <= preview.end;

                              // 塊の枠：食事のあるマスだけを囲う。隣が同じ人かどうかで辺を決めるので、
                              // 入所日の朝や、早く退所する日の昼夕は自然に枠から欠ける。
                              let blk = '';
                              if (shown) {
                                const same = (di: number, mj: number) => occAt(roomKey, di, mj)?.id === shown.id;
                                const top = mi === 0 || !same(i, mi - 1);
                                const bot = mi === MEAL_ROWS.length - 1 || !same(i, mi + 1);
                                const left = i === 0 ? shown.start === iso : !same(i - 1, mi);
                                const right = i === daysInMonth - 1 ? shown.end === iso : !same(i + 1, mi);
                                blk = `${top ? 'rv-t ' : ''}${bot ? 'rv-b ' : ''}${left ? 'rv-l ' : ''}${right ? 'rv-r ' : ''}`;
                              }

                              // rv-occ / rv-kari / rv-empty は白黒印刷用の目印。
                              // 画面の淡い色は刷るとほぼ白なので、印刷側でグレーと斜線に置き換える。
                              const base = eater
                                ? (eater.status === '確定'
                                    ? `rv-occ ${mr.tint} text-gray-900` : 'rv-kari bg-amber-50 text-amber-900')
                                : 'rv-empty ' + (b.staging ? 'bg-slate-50 ' : '') + (dowBg(w) || '') + ' text-gray-300'
                                  + (w === '日' || w === '土' ? ' rv-we' : '');
                              const warn = dupMeal ? 'outline outline-2 outline-red-500 '
                                : clash ? (clash.unknown
                                    ? 'outline outline-2 outline-amber-500 bg-amber-100 '
                                    : 'outline outline-2 outline-red-500 bg-red-100 ')
                                : dupPerson ? 'outline outline-2 outline-red-400 bg-red-100 ' : '';
                              const dnd = inPreview ? 'outline outline-2 outline-sky-600 bg-sky-200 ' : '';

                              const oneTitle = (x: Reservation) =>
                                `${x.name}（${x.status}）${b.name}${pad2(rm.room)}号 ${x.start}〜${x.end}`
                                + (x.inTime ? ` / 入所 ${x.inTime}` : '') + (x.outTime ? ` / 退所 ${x.outTime}` : '')
                                + (x.soutaiIn ? ` / 入所${x.soutaiIn}` : '') + (x.soutaiOut ? ` / 退所${x.soutaiOut}` : '')
                                + (x.note ? ` / ${x.note}` : '');
                              const title = shown
                                ? oneTitle(shown)
                                  + (dupMeal ? `　※この${mr.label}に${cell.eaters.length}人が重なっています` : '')
                                  + (dupPerson ? '　※同じ人が同じ日に別の部屋にも入っています' : '')
                                : timeRv
                                  ? `${oneTitle(timeRv)}　※この${mr.label}は食事なし（部屋は空き）`
                                  : `${mdOf(iso)} ${mr.label} 空き`;
                              const title2 = clash
                                ? `${title}\n⚠ ${mdOf(clash.day)}：${clash.outName} さんの退所${clash.outTime || '（時刻未入力）'} より前に `
                                  + `${clash.inName} さんが入所${clash.inTime || '（時刻未入力）'} になっています`
                                : title;

                              return (
                                <td key={d} title={title2}
                                  draggable={!!shown && !busy}
                                  onDragStart={shown ? e => onDragStart(e, shown, i) : undefined}
                                  onDragEnd={clearDrag}
                                  onDragOver={e => onDragOver(e, b.name, rm.room, i)}
                                  onDrop={e => onDrop(e, b.name, rm.room, i)}
                                  onClick={() => shown ? openEdit(shown) : timeRv ? openEdit(timeRv) : openNew(b.name, rm.room, iso)}
                                  className={`px-0 py-0 cursor-pointer hover:outline hover:outline-2 hover:outline-sky-400 ${
                                    cell.label && nameMode === 'once' ? 'rv-haslabel ' : ''}${
                                    shown ? 'rv-grab ' : ''}${isSource ? 'opacity-40 ' : ''}${timeAlign}${dnd}${warn}${blk}${base}`}>
                                  {(() => {
                                    // このマスに名前を出すか（毎日モードは常に／塊に1回モードは代表マスだけ）
                                    const nameRv = shown && (nameMode === 'every' ? shown : cell.label?.rv) || null;
                                    const nm = nameRv ? tightName(nameRv.name) : '';

                                    if (!nm) {
                                      if (timeHere) return <span className="rv-time">{timeHere}</span>;
                                      return shown ? '' : '・';
                                    }
                                    if (timeHere) {
                                      // 名前と時刻を1マスに並べる。時刻のぶん名前を小さくして収める。
                                      const fs = Math.max(7, Math.min(11, Math.floor((dayW - 30) / Math.max(1, nm.length))));
                                      return (
                                        <span className="rv-both">
                                          <span className="rv-name" style={{ fontSize: fs }}>{nm}</span>
                                          <span className="rv-time">{timeHere}</span>
                                        </span>
                                      );
                                    }
                                    if (nameMode === 'once' && cell.label) {
                                      // 塊の幅いっぱいを使って中央に出す（はみ出しは塊の幅で止まる）
                                      const w = Math.max(dayW, cell.label.runLen * dayW - 4);
                                      const fs = Math.max(9, Math.min(14, Math.floor(w / Math.max(1, nm.length))));
                                      const dx = cell.label.offCells * dayW;
                                      return <span className="rv-name rv-blockname"
                                        style={{ width: w, fontSize: fs, transform: `translate(calc(-50% + ${dx}px), -50%)` }}>{nm}</span>;
                                    }
                                    return <span className="rv-name" style={{ fontSize: fontPxFor(nm, dayW) }}>{nm}</span>;
                                  })()}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </Fragment>
                    );
                };

                return (
                  <>
                    {realB.map((b, bi) => (
                      <Fragment key={b.name}>
                        {/* 前の棟の下に仮置きを1つ置き、そのあとに次の棟の日付行を出す */}
                        {bi > 0 && stagingB && stagingRooms[bi - 1] &&
                          roomRows(stagingB, stagingRooms[bi - 1], { bldSpan: MEAL_ROWS.length, endsGroup: true })}
                        {bi > 0 && dateRow(`date-${b.name}`)}
                        {sumRow(b)}
                        {b.rooms.map((rm, ri) => roomRows(b, rm, {
                          bldSpan: ri === 0 ? b.rooms.length * MEAL_ROWS.length : undefined,
                          endsGroup: ri === b.rooms.length - 1,
                        }))}
                      </Fragment>
                    ))}
                    {/* 棟の間に置ききれなかった仮置きは一番下にまとめる */}
                    {stagingB && stagingRooms.slice(Math.max(0, realB.length - 1)).map(rm =>
                      roomRows(stagingB, rm, { bldSpan: MEAL_ROWS.length, endsGroup: true }))}
                  </>
                );
              })()}
            </tbody>
          </table>
        </div>
      )}

      {/* この月の予約一覧 */}
      <div className="rv-list bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="rv-listhead print:hidden px-3 py-2 font-bold text-sm bg-gray-50 border-b border-gray-200">
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
                <th className="px-2 py-1.5">入所（送迎）</th><th className="px-2 py-1.5">退所（送迎）</th>
                <th className="px-2 py-1.5">備考</th><th className="rv-noprint px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {listRows.map(r => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 font-medium text-gray-800">{r.name}</td>
                  <td className="px-2 py-1.5 text-gray-600">{r.building}{pad2(r.room)}</td>
                  {/* 紙（A4縦）は幅が足りないので月日だけにする */}
                  <td className="px-2 py-1.5 text-gray-600 tabular-nums whitespace-nowrap">
                    <span className="print:hidden">{r.start} 〜 {r.end}</span>
                    <span className="hidden print:inline">{mdOf(r.start)}〜{mdOf(r.end)}</span>
                  </td>
                  <td className="px-2 py-1.5 text-gray-500 tabular-nums">{nightsOf(r.start, r.end)}</td>
                  <td className="px-2 py-1.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${r.status === '確定' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{r.status}</span>
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-600 tabular-nums whitespace-nowrap">
                    {r.inTime} <SoutaiBadge s={r.soutaiIn} />
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-600 tabular-nums whitespace-nowrap">
                    {r.outTime} <SoutaiBadge s={r.soutaiOut} />
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
