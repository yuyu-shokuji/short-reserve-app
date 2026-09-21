'use client';

// 予約台帳の本体。部屋×日付のマトリクス＋予約の追加/編集＋月シートへの書き出し。
// 表示する月は外枠（ReserveApp）から受け取る。台帳そのものは月に依存しないので、
// 未作成の月でも予約は入れられる（書き出しだけができない）。

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

interface Reservation {
  id: string;
  name: string;
  building: string;
  room: number;
  start: string;       // YYYY-MM-DD
  end: string;
  status: '仮予約' | '確定';
  note: string;
  createdAt: string;
  exportedAt: string;
}
interface ReserveConflict { kind: 'room' | 'person'; other: Reservation; days: string[]; }
interface ExportConflict { date: string; building: string; room: number; existing: string; reserved: string; }

const BUILDINGS = ['さくら', 'すみれ'] as const;
const ROOMS_PER_BUILDING = 10;
const ALL_ROOMS = BUILDINGS.flatMap(b =>
  Array.from({ length: ROOMS_PER_BUILDING }, (_, i) => ({ building: b, room: i + 1 })));

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;
const RV_DAY_MIN = 34;   // 日付列の最小幅(px)。これより狭くはせず横スクロールにする

const dowOf = (y: number, m: number, d: number) => WD[new Date(y, m - 1, d).getDay()];
const dowColor = (w: string) => (w === '日' ? 'text-red-500' : w === '土' ? 'text-blue-500' : 'text-gray-500');
const dowBg = (w: string) => (w === '日' ? 'bg-red-50' : w === '土' ? 'bg-blue-50' : '');

/** 名前が長いほど文字を小さくして列に収める */
function fontPxFor(s: string, dayW: number): number {
  const n = Math.max(1, (s || '').length);
  return Math.max(6, Math.min(11, Math.floor(dayW / n)));
}

const todayISO = () => {
  const d = new Date();
  return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

interface Props { year: number; month: number; occupants: string[]; }

interface FormState {
  id: string;            // '' = 新規
  name: string;
  building: string;
  room: number;
  start: string;
  end: string;
  status: '仮予約' | '確定';
  note: string;
}

export default function ReserveLedger({ year, month, occupants }: Props) {
  const [rows, setRows] = useState<Reservation[]>([]);
  const [daysInMonth, setDaysInMonth] = useState(new Date(year, month, 0).getDate());
  const [monthRegistered, setMonthRegistered] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState<FormState>({
    id: '', name: '', building: 'さくら', room: 1,
    start: isoOf(year, month, 1), end: isoOf(year, month, 1), status: '仮予約', note: '',
  });
  const [formOpen, setFormOpen] = useState(false);
  // 保存前に確認する重なり（同じ部屋の二重予約／同じ人が同じ日に別部屋）
  const [saveConflicts, setSaveConflicts] = useState<ReserveConflict[] | null>(null);
  // 書き出し前に確認する先客（月シートに既に別人が入っている日）
  const [expConflicts, setExpConflicts] = useState<ExportConflict[] | null>(null);

  const load = useCallback(async (y: number, m: number, silent = false) => {
    if (!silent) { setLoading(true); setError(''); }
    try {
      const res = await fetch(`/api/reserve?year=${y}&month=${m}`, { cache: 'no-store' });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setRows(j.reservations ?? []);
      setDaysInMonth(j.daysInMonth);
      setMonthRegistered(!!j.monthRegistered);
    } catch (e: any) {
      if (silent) setMsg(`⚠ 更新に失敗：${e.message || '読み込み失敗'}`);
      else setError(e.message || '読み込み失敗');
    } finally { if (!silent) setLoading(false); }
  }, []);

  // 月が変わったら読み直し、開きっぱなしのパネルは閉じる
  useEffect(() => {
    setFormOpen(false); setSaveConflicts(null); setExpConflicts(null); setMsg('');
    load(year, month);
  }, [year, month, load]);

  // 部屋×日付の割り当て表。1マスに複数入るのは二重予約（強制保存したとき）。
  const grid = useMemo(() => {
    const map = new Map<string, Reservation[][]>();
    for (const r of ALL_ROOMS) {
      map.set(`${r.building}-${r.room}`, Array.from({ length: daysInMonth }, () => [] as Reservation[]));
    }
    for (const rv of rows) {
      const cells = map.get(`${rv.building}-${rv.room}`);
      if (!cells) continue;
      for (let d = 1; d <= daysInMonth; d++) {
        const iso = isoOf(year, month, d);
        if (iso >= rv.start && iso <= rv.end) cells[d - 1].push(rv);
      }
    }
    return map;
  }, [rows, daysInMonth, year, month]);

  // その日に空いている部屋数（仮予約も埋まり扱い）
  const vacantPerDay = useMemo(() => Array.from({ length: daysInMonth }, (_, i) =>
    ALL_ROOMS.reduce((n, r) => n + ((grid.get(`${r.building}-${r.room}`)?.[i]?.length ?? 0) ? 0 : 1), 0)),
    [grid, daysInMonth]);

  const openNew = (building: string, room: number, iso: string) => {
    setForm({ id: '', name: '', building, room, start: iso, end: iso, status: '仮予約', note: '' });
    setFormOpen(true); setSaveConflicts(null); setMsg('');
  };
  const openEdit = (rv: Reservation) => {
    setForm({ id: rv.id, name: rv.name, building: rv.building, room: rv.room, start: rv.start, end: rv.end, status: rv.status, note: rv.note });
    setFormOpen(true); setSaveConflicts(null); setMsg('');
  };

  const doSave = async (force = false) => {
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/reserve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, id: form.id || undefined, force }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '保存エラー');
      if (j.conflict) { setSaveConflicts(j.conflicts); return; }
      setSaveConflicts(null); setFormOpen(false);
      await load(year, month, true);
      setMsg(`✓ ${form.name} さん（${form.building}${form.room}号 ${form.start}〜${form.end}・${form.status}）を保存しました`);
    } catch (e: any) { setMsg(`⚠ ${e.message}`); } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (!form.id) return;
    if (!window.confirm(`${form.name} さん（${form.building}${form.room}号 ${form.start}〜${form.end}）の予約を削除します。よろしいですか？\n※ すでに月シートへ書き出したぶんは消えません（「📋 書き出し確認」で確認してください）`)) return;
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/reserve', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: form.id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '削除エラー');
      setFormOpen(false); setSaveConflicts(null);
      await load(year, month, true);
      setMsg(`✓ ${j.removed?.name ?? ''} さんの予約を削除しました`);
    } catch (e: any) { setMsg(`⚠ ${e.message}`); } finally { setBusy(false); }
  };

  const doExport = async (mode?: 'skip' | 'overwrite') => {
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/reserve/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, mode }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '書き出しエラー');
      if (j.conflict) { setExpConflicts(j.conflicts); return; }
      setExpConflicts(null);
      await load(year, month, true);
      const n = j.items?.length ?? 0;
      setMsg(n
        ? `✓ ${year}年${month}月へ ${n}件・のべ${j.days}日ぶんを書き出しました${j.skipped ? `（先客がいる ${j.skipped}日 はとばしました）` : ''}。「📋 書き出し確認」で見られます`
        : '書き出す確定予約がありませんでした');
    } catch (e: any) { setMsg(`⚠ ${e.message}`); } finally { setBusy(false); }
  };

  const confirmed = rows.filter(r => r.status === '確定');
  const nameKnown = !form.name.trim() || occupants.includes(form.name.trim());

  const dates = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const dayW = RV_DAY_MIN;
  const today = todayISO();

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
        }
        .rv-table { border-collapse: collapse; table-layout: fixed; }
        .rv-table th, .rv-table td { border: 1px solid #e5e7eb; white-space: nowrap; text-align: center; overflow: hidden; }
        .rv-table tbody tr.rv-bldend td, .rv-table tbody tr.rv-bldend th { border-bottom: 2px solid #cbd5e1; }
        /* 左に固定する2列（棟・部屋）。背景色は各セルのクラスに任せる
           （ここで白を敷くと棟の色が消える）。固定列には必ず背景色クラスを付けること。 */
        .rv-fix { position: sticky; }
        .rv-table thead .rv-fix { z-index: 25; }
        .rv-table tbody .rv-fix { z-index: 5; }
        /* 仮予約：確定と一目で見分けられるよう斜線を敷く（印刷でも残る） */
        .rv-kari { background-image: repeating-linear-gradient(45deg, rgba(0,0,0,.05) 0 3px, transparent 3px 6px); }
      `}</style>

      <div className="rv-noprint flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">🗂 {year}年{month}月の予約</h2>
        <button onClick={() => openNew('さくら', 1, isoOf(year, month, 1))}
          className="ml-auto bg-emerald-500 text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-emerald-600">＋ 予約を追加</button>
        <button onClick={() => window.print()} className="bg-sky-500 text-white rounded-lg px-3 py-2 text-sm font-semibold">🖨 印刷（A3横）</button>
        <button onClick={() => load(year, month)} className="bg-gray-200 text-gray-700 rounded-lg px-3 py-2 text-sm font-semibold">🔄 更新</button>
      </div>

      <div className="print:block hidden text-base font-bold mb-1">ショート予約台帳　{year}年{month}月</div>

      {/* 月シートへの書き出し */}
      <div className="rv-noprint rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-900 flex items-center gap-3 flex-wrap">
        <span><b>確定 {confirmed.length}件</b>（仮予約 {rows.length - confirmed.length}件）</span>
        {monthRegistered ? (
          <button disabled={busy || !confirmed.length} onClick={() => doExport()}
            className="rounded-lg bg-sky-600 text-white px-4 py-1.5 font-semibold hover:bg-sky-700 disabled:opacity-40">
            📤 {year}年{month}月へ書き出す
          </button>
        ) : (
          <span className="text-amber-700 font-medium">※ {year}年{month}月のシートはまだありません。予約は入れられますが、書き出しは入力アプリの設定タブ「翌月の準備」で月を作ってからになります。</span>
        )}
        <span className="text-xs text-sky-700">確定ぶんだけが書き出されます。仮予約は厨房・経理へ流れません。</span>
      </div>

      {msg && <div className="rv-noprint rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 font-medium">{msg}</div>}
      {error && <div className="rv-noprint text-sm text-red-500 p-2">⚠ {error}</div>}

      {/* 書き出しの先客確認 */}
      {expConflicts && (
        <div className="rv-noprint rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 space-y-2">
          <div className="font-bold">⚠ 月シートに先客がいる日があります（まだ何も書いていません）</div>
          <ul className="list-disc pl-5 max-h-40 overflow-y-auto">
            {expConflicts.map((c, i) => (
              <li key={i}>{c.date}　{c.building}{pad2(c.room)}号：いま <b>{c.existing}</b> さん／予約は <b>{c.reserved}</b> さん</li>
            ))}
          </ul>
          <div className="flex items-center gap-2 flex-wrap">
            <button disabled={busy} onClick={() => doExport('skip')} className="px-3 py-1.5 rounded-lg bg-white border border-amber-400 text-amber-800 font-bold hover:bg-amber-100 disabled:opacity-40">先客の日はとばして書き出す</button>
            <button disabled={busy} onClick={() => doExport('overwrite')} className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 disabled:opacity-40">先客ごと上書きする</button>
            <button disabled={busy} onClick={() => setExpConflicts(null)} className="px-2 py-1.5 text-amber-700 underline">やめる</button>
          </div>
        </div>
      )}

      {/* 予約の追加・編集 */}
      {formOpen && (
        <div className="rv-noprint rounded-xl border border-emerald-200 bg-white p-4 space-y-3">
          <div className="font-bold text-gray-800">{form.id ? '✏️ 予約を編集' : '＋ 予約を追加'}</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">氏名</span>
              <input list="rv-occupants" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm" placeholder="氏名を選ぶ / 入力" />
              <datalist id="rv-occupants">{occupants.map(o => <option key={o} value={o} />)}</datalist>
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">棟</span>
              <select value={form.building} onChange={e => setForm(f => ({ ...f, building: e.target.value }))}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white">
                {BUILDINGS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">部屋</span>
              <select value={form.room} onChange={e => setForm(f => ({ ...f, room: Number(e.target.value) }))}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white">
                {Array.from({ length: ROOMS_PER_BUILDING }, (_, i) => i + 1).map(n => <option key={n} value={n}>{pad2(n)}号</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">状態</span>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as '仮予約' | '確定' }))}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white">
                <option value="仮予約">仮予約</option>
                <option value="確定">確定</option>
              </select>
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">開始日（入所日）</span>
              <input type="date" value={form.start}
                onChange={e => setForm(f => ({ ...f, start: e.target.value, end: f.end < e.target.value ? e.target.value : f.end }))}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs text-gray-600 space-y-1">
              <span className="font-semibold">終了日（退所日）</span>
              <input type="date" value={form.end} min={form.start}
                onChange={e => setForm(f => ({ ...f, end: e.target.value }))}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs text-gray-600 space-y-1 col-span-2">
              <span className="font-semibold">備考</span>
              <input type="text" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm" placeholder="送迎・連絡先など" />
            </label>
          </div>

          {!nameKnown && (
            <div className="text-xs text-amber-700">
              ※「{form.name}」さんはショートの名簿にいません。予約は入れられますが、食事形態・禁止食などを出すには入力アプリの「✏️ 利用者追加」で登録してください。
            </div>
          )}

          {saveConflicts && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 space-y-2">
              <div className="font-bold">⚠ 予約が重なっています（まだ保存していません）</div>
              <ul className="list-disc pl-5 max-h-32 overflow-y-auto">
                {saveConflicts.map((c, i) => (
                  <li key={i}>
                    {c.kind === 'room'
                      ? <>同じ部屋（{c.other.building}{pad2(c.other.room)}号）に <b>{c.other.name}</b> さんの{c.other.status}：{c.days[0]}〜{c.days[c.days.length - 1]}</>
                      : <><b>{c.other.name}</b> さんは同じ日に {c.other.building}{pad2(c.other.room)}号 にも{c.other.status}：{c.days[0]}〜{c.days[c.days.length - 1]}</>}
                  </li>
                ))}
              </ul>
              <button disabled={busy} onClick={() => doSave(true)} className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 disabled:opacity-40">重なったまま保存する</button>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button disabled={busy} onClick={() => doSave()} className="px-4 py-2 rounded-lg bg-emerald-500 text-white font-bold hover:bg-emerald-600 disabled:opacity-40">保存</button>
            {form.id && <button disabled={busy} onClick={doDelete} className="px-4 py-2 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 disabled:opacity-40">🗑 削除</button>}
            <button disabled={busy} onClick={() => { setFormOpen(false); setSaveConflicts(null); }} className="px-3 py-2 text-gray-500 underline">閉じる</button>
            {busy && <span className="text-sm text-gray-400 animate-pulse">処理中...</span>}
          </div>
        </div>
      )}

      {/* 部屋×日付 */}
      {loading ? <div className="text-sm text-gray-400 animate-pulse p-4">読み込み中...</div> : (
        <div className="rv-scroll bg-white rounded-xl border border-gray-100 shadow-sm overflow-auto max-h-[64vh] print:max-h-none">
          <table className="rv-table text-[11px]" style={{ width: 40 + 34 + dayW * daysInMonth }}>
            <colgroup>
              <col style={{ width: 40 }} />
              <col style={{ width: 34 }} />
              {dates.map(d => <col key={d} style={{ width: dayW }} />)}
            </colgroup>
            <thead>
              <tr>
                <th className="rv-fix left-0 bg-gray-50 px-1 py-1 text-gray-500 font-semibold sticky top-0">棟</th>
                <th className="rv-fix bg-gray-50 px-1 py-1 text-gray-500 font-semibold sticky top-0 print:left-auto" style={{ left: 40 }}>部屋</th>
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
              {BUILDINGS.map(b => (
                <Fragment key={b}>
                {Array.from({ length: ROOMS_PER_BUILDING }, (_, i) => i + 1).map(room => {
                const cells = grid.get(`${b}-${room}`)!;
                return (
                  <tr key={`${b}-${room}`} className={room === ROOMS_PER_BUILDING ? 'rv-bldend' : ''}>
                    {room === 1 && (
                      <th rowSpan={ROOMS_PER_BUILDING}
                        className={`rv-fix left-0 px-1 py-1 text-[10px] font-bold ${b === 'さくら' ? 'bg-rose-50 text-rose-700' : 'bg-purple-50 text-purple-700'}`}>{b}</th>
                    )}
                    <th className="rv-fix bg-white px-1 py-1 font-bold text-gray-600 print:left-auto" style={{ left: 40 }}>{pad2(room)}</th>
                    {cells.map((list, i) => {
                      const rv = list[0];
                      const iso = isoOf(year, month, i + 1);
                      const w = dowOf(year, month, i + 1);
                      const dup = list.length > 1;
                      const tone = !rv ? (dowBg(w) || '') + ' text-gray-300'
                        : rv.status === '確定' ? 'bg-emerald-100 text-emerald-900 font-medium'
                        : 'bg-amber-50 text-amber-800 rv-kari';
                      return (
                        <td key={i}
                          title={rv ? `${rv.name}（${rv.status}）${rv.building}${pad2(rv.room)}号 ${rv.start}〜${rv.end}${rv.note ? ` / ${rv.note}` : ''}${dup ? `　※${list.length}件が重なっています` : ''}` : `${iso} 空き`}
                          onClick={() => rv ? openEdit(rv) : openNew(b, room, iso)}
                          style={rv ? { fontSize: fontPxFor(rv.name, dayW) } : undefined}
                          className={`px-0 py-1 cursor-pointer hover:outline hover:outline-2 hover:outline-sky-400 ${dup ? 'outline outline-2 outline-red-500 ' : ''}${tone}`}>
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
                <th colSpan={2} className="rv-fix left-0 bg-gray-50 px-1 py-1 text-[10px] text-gray-600 font-bold">空き</th>
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
                <th className="px-2 py-1.5">状態</th><th className="px-2 py-1.5">書出</th>
                <th className="px-2 py-1.5">備考</th><th className="rv-noprint px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const nights = Math.round((new Date(r.end).getTime() - new Date(r.start).getTime()) / 86400000);
                return (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-3 py-1.5 font-medium text-gray-800">{r.name}</td>
                    <td className="px-2 py-1.5 text-gray-600">{r.building}{pad2(r.room)}</td>
                    <td className="px-2 py-1.5 text-gray-600 tabular-nums">{r.start} 〜 {r.end}</td>
                    <td className="px-2 py-1.5 text-gray-500 tabular-nums">{nights}</td>
                    <td className="px-2 py-1.5">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${r.status === '確定' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{r.status}</span>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-gray-400">{r.exportedAt || (r.status === '確定' ? '未' : '')}</td>
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
        ※ 予約は月に依存しない「ショート予約」シートに入ります。翌月シートが未作成でも先の予約を入れられます。
        空きマスをクリックで追加、予約のマスをクリックで編集。<b>確定</b>にしてから「📤 この月へ書き出す」で入力アプリの ショート_記録 に反映され、そこから先は厨房・経理に流れます。
        書き出しは「空いているところへ書く」だけで、先客がいる日はとばすか上書きかを都度たずねます。書き出し後に予約を消しても月シートは消えません（入力アプリの全体一覧「🔧 塊を編集」で消してください）。
        食事は現場ルールどおり、入所日は朝なし・退所日は夕なし・単日は昼のみで入ります。
      </p>
    </div>
  );
}
