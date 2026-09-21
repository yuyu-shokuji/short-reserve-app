'use client';

// 予約台帳の本体。部屋×日付のマトリクス＋予約の追加/編集。
//
// 現場の手間に合わせて入れてあるもの：
//  ・期間を入れるとその場で空き部屋が分かる（部屋の選択肢に ○/× と、ふさいでいる人の名前）
//  ・同じ部屋の二重予約と、同じ人を同じ日に別の部屋へ入れる「逆ダブルブッキング」を保存前に知らせる
//  ・すでに入っている逆ダブルブッキングは表の中で赤く出す
//  ・期間の変更は ±1日ボタンで（延長・短縮が多いため）

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Person } from './ReserveApp';

interface Reservation {
  id: string;
  name: string;
  building: string;
  room: number;
  start: string;
  end: string;
  status: '仮予約' | '確定';
  soutai: boolean;
  pickupTime: string;
  dropTime: string;
  note: string;
  createdAt: string;
}
interface Room { building: string; room: number; disabled: boolean; note: string; }
interface Conflict { kind: 'room' | 'person'; other: Reservation; days: string[]; }
interface Vacancy {
  building: string; room: number; free: boolean;
  takenBy?: { name: string; start: string; end: string; status: string }[];
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;
const DAY_W = 34;   // 日付列の幅(px)。狭い画面では横スクロール

const dowOf = (y: number, m: number, d: number) => WD[new Date(y, m - 1, d).getDay()];
const dowColor = (w: string) => (w === '日' ? 'text-red-500' : w === '土' ? 'text-blue-500' : 'text-gray-500');
const dowBg = (w: string) => (w === '日' ? 'bg-red-50' : w === '土' ? 'bg-blue-50' : '');

/** 名前が長いほど文字を小さくして列に収める */
function fontPxFor(s: string): number {
  const n = Math.max(1, (s || '').length);
  return Math.max(6, Math.min(11, Math.floor(DAY_W / n)));
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

interface FormState {
  id: string;            // '' = 新規
  name: string;
  building: string;
  room: number;
  start: string;
  end: string;
  status: '仮予約' | '確定';
  soutai: boolean;
  pickupTime: string;
  dropTime: string;
  note: string;
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

  useEffect(() => { setForm(null); setConflicts(null); setMsg(''); load(); }, [load]);

  // 建物ごとの部屋（部屋シートの並びを尊重する）
  const buildings = useMemo(() => {
    const out: { name: string; rooms: Room[] }[] = [];
    for (const r of rooms) {
      let g = out.find(x => x.name === r.building);
      if (!g) { g = { name: r.building, rooms: [] }; out.push(g); }
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

  // 逆ダブルブッキング：同じ人が同じ日に2部屋以上に入っているマス
  const doubleBooked = useMemo(() => {
    const perDay = new Map<string, Set<string>>();   // "名前|日付" → 部屋の集合
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

  // その日に空いている部屋数
  const vacantPerDay = useMemo(() => Array.from({ length: daysInMonth }, (_, i) =>
    rooms.filter(r => !r.disabled).reduce((n, r) => n + ((grid.get(`${r.building}-${r.room}`)?.[i]?.length ?? 0) ? 0 : 1), 0)),
    [grid, rooms, daysInMonth]);

  // ── 期間を入れたら空き部屋を調べる（問い合わせ中にすぐ答えるため） ──
  const vacReq = useRef(0);
  useEffect(() => {
    if (!form?.start || !form?.end || form.end < form.start) { setVacancy(null); return; }
    const seq = ++vacReq.current;
    setVacLoading(true);
    const t = setTimeout(async () => {
      try {
        const q = new URLSearchParams({ start: form.start, end: form.end });
        if (form.id) q.set('excludeId', form.id);
        const j = await (await fetch(`/api/vacancy?${q}`, { cache: 'no-store' })).json();
        if (seq === vacReq.current) setVacancy(j.error ? null : j);
      } catch { if (seq === vacReq.current) setVacancy(null); }
      finally { if (seq === vacReq.current) setVacLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [form?.start, form?.end, form?.id]);

  const vacOf = (building: string, room: number) =>
    vacancy?.vacancies.find(v => v.building === building && v.room === room);

  const openNew = (building: string, room: number, iso: string) => {
    setForm({
      id: '', name: '', building, room, start: iso, end: iso,
      status: '仮予約', soutai: false, pickupTime: '', dropTime: '', note: '',
    });
    setConflicts(null); setMsg('');
  };
  const openEdit = (rv: Reservation) => {
    setForm({
      id: rv.id, name: rv.name, building: rv.building, room: rv.room,
      start: rv.start, end: rv.end, status: rv.status,
      soutai: rv.soutai, pickupTime: rv.pickupTime, dropTime: rv.dropTime, note: rv.note,
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
    if (!window.confirm(`${form.name} さん（${form.building}${pad2(form.room)}号 ${form.start}〜${form.end}）の予約を削除します。よろしいですか？`)) return;
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/reserve', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: form.id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '削除エラー');
      setForm(null); setConflicts(null);
      await load(true);
      setMsg(`✓ ${j.removed?.name ?? ''} さんの予約を削除しました`);
    } catch (e: any) { setMsg(`⚠ ${e.message}`); } finally { setBusy(false); }
  };

  const nameKnown = !form?.name.trim() || people.some(p => p.name === form.name.trim());
  const dates = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const today = todayISO();
  const nights = form ? Math.round((new Date(form.end).getTime() - new Date(form.start).getTime()) / 86400000) : 0;

  const freeList = vacancy?.vacancies.filter(v => v.free) ?? [];

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
        .rv-table th, .rv-table td { border: 1px solid #e5e7eb; white-space: nowrap; text-align: center; overflow: hidden; }
        .rv-table tbody tr.rv-bldend td, .rv-table tbody tr.rv-bldend th { border-bottom: 2px solid #cbd5e1; }
        /* 左に固定する2列。背景色は各セルのクラスに任せる（ここで白を敷くと棟の色が消える）。 */
        .rv-fix { position: sticky; }
        .rv-table thead .rv-fix { z-index: 25; }
        .rv-table tbody .rv-fix { z-index: 5; }
        /* 仮予約：確定と一目で見分けられるよう斜線を敷く（印刷でも残る） */
        .rv-kari { background-image: repeating-linear-gradient(45deg, rgba(0,0,0,.05) 0 3px, transparent 3px 6px); }
      `}</style>

      <div className="rv-noprint flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">{year}年{month}月の予約</h2>
        <span className="text-sm text-gray-500">
          確定 {rows.filter(r => r.status === '確定').length}件 ／ 仮予約 {rows.filter(r => r.status === '仮予約').length}件
        </span>
        <button onClick={() => openNew(rooms[0]?.building ?? 'さくら', rooms[0]?.room ?? 1, isoOf(year, month, 1))}
          className="ml-auto bg-emerald-500 text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-emerald-600">＋ 予約を追加</button>
        <button onClick={() => window.print()} className="bg-sky-500 text-white rounded-lg px-3 py-2 text-sm font-semibold">🖨 印刷（A3横）</button>
        <button onClick={() => load()} className="bg-gray-200 text-gray-700 rounded-lg px-3 py-2 text-sm font-semibold">🔄 更新</button>
      </div>

      <div className="print:block hidden text-base font-bold mb-1">ショート予約台帳　{year}年{month}月</div>

      {msg && <div className="rv-noprint rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 font-medium">{msg}</div>}
      {error && <div className="rv-noprint rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">⚠ {error}</div>}
      {doubleBooked.size > 0 && (
        <div className="rv-noprint rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          ⚠ 同じ人が同じ日に2部屋以上に入っています（表の赤いマス）。どちらかを直してください。
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
            <div className="text-sm text-gray-600 pb-2">{nights}泊{nights + 1}日</div>
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
                  const mark = !vacancy ? '' : v?.free ? '　○ 空き' : `　× ${v?.takenBy?.[0]?.name ?? '予約あり'}`;
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

          {/* 送迎 */}
          <div className="flex items-end gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-gray-700 pb-2">
              <input type="checkbox" checked={form.soutai} onChange={e => patch({ soutai: e.target.checked })} className="w-4 h-4" />
              <span className="font-semibold">送迎あり</span>
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">迎え（入所日）</span>
              <input type="time" value={form.pickupTime} disabled={!form.soutai}
                onChange={e => patch({ pickupTime: e.target.value })}
                className={`border border-gray-200 rounded-md px-2 py-1.5 text-sm ${form.soutai ? '' : 'opacity-40'}`} />
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold block">送り（退所日）</span>
              <input type="time" value={form.dropTime} disabled={!form.soutai}
                onChange={e => patch({ dropTime: e.target.value })}
                className={`border border-gray-200 rounded-md px-2 py-1.5 text-sm ${form.soutai ? '' : 'opacity-40'}`} />
            </label>
            <label className="text-xs text-gray-600 space-y-1 flex-1 min-w-[200px]">
              <span className="font-semibold block">備考</span>
              <input type="text" value={form.note} onChange={e => patch({ note: e.target.value })}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm" placeholder="連絡事項など" />
            </label>
          </div>

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
                      ? <>同じ部屋（{c.other.building}{pad2(c.other.room)}号）に <b>{c.other.name}</b> さんの{c.other.status}：{c.days[0]}〜{c.days[c.days.length - 1]}</>
                      : <><b className="text-red-700">同じ人を別の部屋にも</b>：{c.other.name} さんは {c.other.building}{pad2(c.other.room)}号 にも{c.other.status}（{c.days[0]}〜{c.days[c.days.length - 1]}）</>}
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
        <div className="rv-scroll bg-white rounded-xl border border-gray-100 shadow-sm overflow-auto max-h-[64vh] print:max-h-none">
          <table className="rv-table text-[11px]" style={{ width: 40 + 34 + DAY_W * daysInMonth }}>
            <colgroup>
              <col style={{ width: 40 }} />
              <col style={{ width: 34 }} />
              {dates.map(d => <col key={d} style={{ width: DAY_W }} />)}
            </colgroup>
            <thead>
              <tr>
                <th style={{ left: 0 }} className="rv-fix bg-gray-50 px-1 py-1 text-gray-500 font-semibold sticky top-0">棟</th>
                <th style={{ left: 40 }} className="rv-fix bg-gray-50 px-1 py-1 text-gray-500 font-semibold sticky top-0">部屋</th>
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
                    const cells = grid.get(`${b.name}-${rm.room}`) ?? [];
                    return (
                      <tr key={`${b.name}-${rm.room}`} className={ri === b.rooms.length - 1 ? 'rv-bldend' : ''}>
                        {ri === 0 && (
                          <th rowSpan={b.rooms.length} style={{ left: 0 }}
                            className={`rv-fix px-1 py-1 text-[10px] font-bold ${b.name === 'さくら' ? 'bg-rose-50 text-rose-700' : 'bg-purple-50 text-purple-700'}`}>{b.name}</th>
                        )}
                        <th style={{ left: 40 }} className={`rv-fix px-1 py-1 font-bold ${rm.disabled ? 'bg-gray-100 text-gray-300' : 'bg-white text-gray-600'}`}>{pad2(rm.room)}</th>
                        {cells.map((list, i) => {
                          const rv = list[0];
                          const iso = isoOf(year, month, i + 1);
                          const w = dowOf(year, month, i + 1);
                          const dupRoom = list.length > 1;
                          const dupPerson = !!rv && doubleBooked.has(`${rv.name}|${iso}`);
                          const tone = !rv ? (dowBg(w) || '') + ' text-gray-300'
                            : rv.status === '確定' ? 'bg-emerald-100 text-emerald-900 font-medium'
                            : 'bg-amber-50 text-amber-800 rv-kari';
                          const warn = dupRoom ? 'outline outline-2 outline-red-500 '
                            : dupPerson ? 'outline outline-2 outline-red-400 bg-red-100 ' : '';
                          const title = rv
                            ? `${rv.name}（${rv.status}）${rv.building}${pad2(rv.room)}号 ${rv.start}〜${rv.end}`
                              + (rv.soutai ? ` / 送迎あり${rv.pickupTime ? ` 迎${rv.pickupTime}` : ''}${rv.dropTime ? ` 送${rv.dropTime}` : ''}` : '')
                              + (rv.note ? ` / ${rv.note}` : '')
                              + (dupRoom ? `　※この部屋に${list.length}件が重なっています` : '')
                              + (dupPerson ? '　※同じ人が同じ日に別の部屋にも入っています' : '')
                            : `${iso} 空き`;
                          return (
                            <td key={i} title={title}
                              onClick={() => rv ? openEdit(rv) : openNew(b.name, rm.room, iso)}
                              style={rv ? { fontSize: fontPxFor(rv.name) } : undefined}
                              className={`px-0 py-1 cursor-pointer hover:outline hover:outline-2 hover:outline-sky-400 ${warn}${tone}`}>
                              {rv ? rv.name : '・'}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
              {/* その日の空き部屋数 */}
              <tr>
                <th colSpan={2} style={{ left: 0 }} className="rv-fix bg-gray-50 px-1 py-1 text-[10px] text-gray-600 font-bold">空き</th>
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
        <div className="px-3 py-2 font-bold text-sm bg-gray-50 border-b border-gray-200">{year}年{month}月にかかる予約（{rows.length}件）</div>
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-sm text-gray-400">この月の予約はまだありません。</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 bg-gray-50">
                <th className="px-3 py-1.5">氏名</th><th className="px-2 py-1.5">部屋</th>
                <th className="px-2 py-1.5">期間</th><th className="px-2 py-1.5">泊</th>
                <th className="px-2 py-1.5">状態</th><th className="px-2 py-1.5">送迎</th>
                <th className="px-2 py-1.5">備考</th><th className="rv-noprint px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const n = Math.round((new Date(r.end).getTime() - new Date(r.start).getTime()) / 86400000);
                return (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-3 py-1.5 font-medium text-gray-800">{r.name}</td>
                    <td className="px-2 py-1.5 text-gray-600">{r.building}{pad2(r.room)}</td>
                    <td className="px-2 py-1.5 text-gray-600 tabular-nums">{r.start} 〜 {r.end}</td>
                    <td className="px-2 py-1.5 text-gray-500 tabular-nums">{n}</td>
                    <td className="px-2 py-1.5">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${r.status === '確定' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{r.status}</span>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-gray-600">
                      {r.soutai ? `あり${r.pickupTime ? ` 迎${r.pickupTime}` : ''}${r.dropTime ? ` 送${r.dropTime}` : ''}` : ''}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-gray-500">{r.note}</td>
                    <td className="rv-noprint px-2 py-1.5">
                      <button onClick={() => openEdit(r)} className="text-sky-600 underline text-xs">編集</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="rv-noprint text-xs text-gray-400">
        ※ 空きマスをクリックで追加、予約のマスをクリックで編集。期間を入れると、その期間を丸ごと押さえられる部屋が選択肢に「○」で出ます。
        同じ部屋の二重予約と、同じ人を同じ日に別の部屋へ入れてしまうのは、保存前に知らせます（すでに入っているものは表の赤いマス）。
        データは予約台帳スプレッドシートだけを見ています。食事管理アプリとの連動はこれからです。
      </p>
    </div>
  );
}
