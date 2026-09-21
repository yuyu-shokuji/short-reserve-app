'use client';

// 書き出し確認：その月の ショート_記録 をそのまま見るだけの画面。
// 入力アプリの「全体一覧」と同じ見え方にしてあるが、こちらは読み取り専用で編集機能はない
// （このアプリから月シートを触るのは「書き出し」だけ、という切り分け）。

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

interface OverviewDay { m: string; l: string; d: string; occ: string; }
interface OverviewRoom { building: string; roomNum: number; days: OverviewDay[]; }
interface OverviewData {
  year: number; month: number; daysInMonth: number; rooms: OverviewRoom[];
}

const BUILDINGS: { key: string; label: string }[] = [
  { key: 'さくら', label: '🌸 さくら' },
  { key: 'すみれ', label: '💜 すみれ' },
];
const MEAL_ROWS: { key: 'm' | 'l' | 'd'; label: string; tint: string }[] = [
  { key: 'm', label: '朝', tint: 'bg-amber-50' },
  { key: 'l', label: '昼', tint: 'bg-sky-50' },
  { key: 'd', label: '夕', tint: 'bg-indigo-50' },
];

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const OV_W = { bld: 24, room: 32, meal: 24 };
const OV_DAY_MIN = 54;

const dowOf = (y: number, m: number, d: number) => WD[new Date(y, m - 1, d).getDay()];
const dowColor = (w: string) => (w === '日' ? 'text-red-500' : w === '土' ? 'text-blue-500' : 'text-gray-500');
const dowBg = (w: string) => (w === '日' ? 'bg-red-50' : w === '土' ? 'bg-blue-50' : '');

/** 氏名の文字サイズ＝列幅÷文字数。列に必ず収まり、広い画面では自動的に大きくなる。 */
function fontPxFor(s: string, dayW: number): number {
  const n = Math.max(1, (s || '').length);
  return Math.max(6, Math.min(11, Math.floor(dayW / n)));
}

export default function MonthOverview({ year, month }: { year: number; month: number }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const bodyRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState(0);
  useEffect(() => {
    const measure = () => { if (bodyRef.current) setAvailW(bodyRef.current.clientWidth); };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [data]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/overview?year=${year}&month=${month}`, { cache: 'no-store' });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setData(j);
    } catch (e: any) {
      setData(null);
      setError(e.message || '読み込み失敗');
    } finally { setLoading(false); }
  }, [year, month]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-sm text-gray-400 animate-pulse p-4">読み込み中...</div>;
  if (error) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
        ⚠ {error}
        <div className="text-xs text-amber-700 mt-1">
          まだ作られていない月です。入力アプリの設定タブ「翌月の準備」で月を作ると見られるようになります。
        </div>
      </div>
    );
  }
  if (!data) return null;

  const { daysInMonth } = data;
  const dates = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const fixedW = OV_W.bld + OV_W.room + OV_W.meal;
  const dayW = Math.max(OV_DAY_MIN, Math.floor(((availW || 0) - fixedW) / daysInMonth) || 0);

  return (
    <div className="ov-print space-y-4">
      <style>{`
        @media print {
          @page { size: A3 landscape; margin: 6mm; }
          body * { visibility: hidden !important; }
          .ov-print, .ov-print * { visibility: visible !important; }
          .ov-print { position: absolute; left: 0; top: 0; width: 100%; }
          .ov-noprint, .rsv-noprint { display: none !important; }
          .ov-section { break-inside: avoid; }
          .ov-section + .ov-section { break-before: page; }
          .ov-table td, .ov-table th { padding: 0 1px !important; }
          .short-body { overflow: visible !important; max-height: none !important; }
        }
        .ov-table { border-collapse: collapse; table-layout: fixed; }
        .ov-table th, .ov-table td { border: 1px solid #e5e7eb; white-space: nowrap; text-align: center; overflow: hidden; }
        .ov-table tbody tr.ov-roomend td, .ov-table tbody tr.ov-roomend th { border-bottom: 2px solid #cbd5e1; }
        /* 左に固定する3列（棟・部屋・食）。列幅は colgroup で固定なので left はJSで直接指定する。
           背景色はここで指定せず各セルのクラスに任せる（ここで白を敷くと棟の色が消えるため）。
           固定列のセルには必ず背景色クラスを付けること＝透けると下の日付が見えてしまう。 */
        .ov-fixcol { position: sticky; }
        .ov-table thead .ov-fixcol { z-index: 25; }
        .ov-table tbody .ov-fixcol { z-index: 5; }
        @media print { .ov-fixcol { position: static !important; } }
        .short-body { overflow: auto; }
        /* 在室だがその食事は食べない人。空室（・）と区別できるよう薄く出す。 */
        .ov-table td.ov-stay { color: #cbd5e1; font-style: italic; }
        @media print { .ov-table td.ov-stay { color: #94a3b8 !important;
          -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; } }
      `}</style>

      <div className="ov-noprint flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">📋 {year}年{month}月の月シート</h2>
        <span className="text-sm text-gray-500">部屋×朝昼夕／横＝日付／セル＝その食事の利用者（読み取り専用）</span>
        <button onClick={() => window.print()} className="ml-auto bg-sky-500 text-white rounded-lg px-4 py-2 text-sm font-semibold">🖨 印刷（A3横）</button>
        <button onClick={load} className="bg-gray-200 text-gray-700 rounded-lg px-3 py-2 text-sm font-semibold">🔄 更新</button>
      </div>

      <div className="print:block hidden text-base font-bold mb-1">ショート全体一覧　{year}年{month}月</div>

      <div ref={bodyRef} className="short-body bg-white rounded-xl border border-gray-100 shadow-sm max-h-[70vh] print:max-h-none">
        {BUILDINGS.map(b => {
          const rooms = data.rooms.filter(r => r.building === b.key);
          if (!rooms.length) return null;
          return (
            <div key={b.key} className="ov-section">
              <div className="px-3 py-2 font-bold text-sm bg-gray-50 border-b border-gray-200">{b.label}</div>
              <table className="ov-table text-[11px]" style={{ width: fixedW + dayW * daysInMonth }}>
                <colgroup>
                  <col style={{ width: OV_W.bld }} />
                  <col style={{ width: OV_W.room }} />
                  <col style={{ width: OV_W.meal }} />
                  {dates.map(d => <col key={d} style={{ width: dayW }} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th colSpan={3} style={{ left: 0 }} className="ov-fixcol bg-gray-50 px-1 py-1 text-gray-500 font-semibold sticky top-0 z-30 print:static">部屋</th>
                    {dates.map(d => {
                      const w = dowOf(year, month, d);
                      return (
                        <th key={d} className={`px-1 py-1 font-semibold sticky top-0 z-10 print:static ${dowColor(w)} ${dowBg(w) || 'bg-gray-50'}`}>
                          <div>{d}</div><div className="text-[9px] font-normal">{w}</div>
                        </th>
                      );
                    })}
                  </tr>
                  {/* その日の利用者数（その日に食事のある人。1部屋を2人利用＝2名） */}
                  <tr>
                    <th colSpan={3} style={{ left: 0 }} className="ov-fixcol bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600 font-bold sticky top-0 z-20 print:static">利用者数</th>
                    {dates.map((d, i) => {
                      const set = new Set<string>();
                      rooms.forEach(r => { const day = r.days[i]; (['m', 'l', 'd'] as const).forEach(k => { if (day[k]) set.add(day[k]); }); });
                      const c = set.size;
                      return <th key={d} className={`px-1 py-0.5 text-[11px] font-bold ${dowBg(WD[new Date(year, month - 1, d).getDay()]) || 'bg-gray-50'} ${c ? 'text-emerald-700' : 'text-gray-300'}`}>{c ? `（${c}）` : ''}</th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rooms.map(r => (
                    <Fragment key={r.roomNum}>
                      {MEAL_ROWS.map((mr, mi) => (
                        <tr key={mr.key} className={mi === MEAL_ROWS.length - 1 ? 'ov-roomend' : ''}>
                          {mi === 0 && (
                            <th rowSpan={3} style={{ left: 0 }}
                              className={`ov-fixcol px-1 py-1 text-[10px] font-bold ov-roomend ${b.key === 'さくら' ? 'bg-rose-50 text-rose-700' : 'bg-purple-50 text-purple-700'}`}>{b.key}</th>
                          )}
                          {mi === 0 && (
                            <th rowSpan={3} style={{ left: OV_W.bld }}
                              className="ov-fixcol px-2 py-1 font-bold text-gray-600 ov-roomend bg-white">{String(r.roomNum).padStart(2, '0')}</th>
                          )}
                          <td style={{ left: OV_W.bld + OV_W.room }}
                            className="ov-fixcol px-1 py-0.5 text-[10px] font-bold text-gray-500 bg-gray-50">{mr.label}</td>
                          {r.days.map((day, i) => {
                            const occ = day[mr.key];
                            // 在室だが この食事は食べない人。空室（・）と見分けるため薄く名前を出す。
                            const stay = !occ && day.occ ? day.occ : '';
                            const shown = occ || stay;
                            const w = dowOf(year, month, i + 1);
                            const isWend = w === '土' || w === '日';
                            const tone = isWend
                              ? dowBg(w) + (occ ? ' text-gray-800' : ' text-gray-300')
                              : (occ ? mr.tint + ' text-gray-800' : 'text-gray-300');
                            return (
                              <td key={i} title={stay ? `${stay}（この食事はなし）` : occ}
                                style={shown ? { fontSize: fontPxFor(shown, dayW) } : undefined}
                                className={`px-0 py-0.5 ${tone}${stay ? ' ov-stay' : ''}`}>
                                {shown || '・'}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <p className="ov-noprint text-xs text-gray-400">
        ※ 入力アプリ（食事管理アプリ）の ショート_記録 をそのまま表示しています。ここでは編集できません。
        在室だがその食事がない日は薄い斜体の氏名、空室は「・」です。直したいときは入力アプリのショート画面で操作してください。
      </p>
    </div>
  );
}
