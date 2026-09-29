'use client';

// アプリの外枠。ヘッダーと月送りだけを持ち、中身は ReserveLedger。

import { useCallback, useEffect, useState } from 'react';
import ReserveLedger, { LedgerSummary } from './ReserveLedger';

export interface Person { name: string; furi: string; contact: string; note: string; }

export default function ReserveApp() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [people, setPeople] = useState<Person[]>([]);
  const [setupError, setSetupError] = useState('');
  // 件数と稼働率はチャート側で数えている。上の帯に1行で並べたいので受け取る。
  const [summary, setSummary] = useState<LedgerSummary | null>(null);

  // 氏名の候補（利用者シート）。滅多に変わらないので起動時だけ読む。
  useEffect(() => {
    fetch('/api/master', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.error) setSetupError(j.error); else setPeople(j.people ?? []); })
      .catch(e => setSetupError(String(e)));
  }, []);

  const shiftMonth = useCallback((delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }, [year, month]);

  const isThisMonth = year === now.getFullYear() && month === now.getMonth() + 1;

  return (
    // チャートを少しでも広く見せたいので、上の帯は1行に収める
    <div className="w-full px-2 py-2 mx-auto space-y-2">
      <div className="rsv-noprint bg-white rounded-xl shadow-sm border border-gray-100 px-3 py-1.5">
        {/* 左から タイトル → 月選び → その月の予約情報 の順に1行で並べる（現場の指定） */}
        <div className="flex items-center gap-x-5 gap-y-1 flex-wrap">
          <div className="flex items-baseline gap-2">
            <span className="text-lg">🛏</span>
            <h1 className="text-base font-bold text-gray-800">ショート予約台帳</h1>
            <span className="text-xs text-gray-400">グラン悠遊</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => shiftMonth(-1)} aria-label="前の月"
              className="px-2.5 py-1 rounded-lg bg-gray-100 text-gray-700 font-bold hover:bg-gray-200">◀</button>
            <span className="px-2 font-bold text-gray-800 tabular-nums">{year}年{month}月</span>
            <button onClick={() => shiftMonth(1)} aria-label="次の月"
              className="px-2.5 py-1 rounded-lg bg-gray-100 text-gray-700 font-bold hover:bg-gray-200">▶</button>
            {!isThisMonth && (
              <button onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth() + 1); }}
                className="ml-1 px-2 py-0.5 text-xs text-sky-600 underline">今月へ</button>
            )}
          </div>
          {summary && (
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-sm text-gray-500 tabular-nums">
                確定 {summary.confirmed}件 ／ 仮予約 {summary.tentative}件
              </span>
              {summary.pct !== null && (
                <span className="text-sm font-bold text-indigo-700 tabular-nums"
                  title={`埋まっていた ${summary.used} 室日 ÷ ${summary.rooms}室 × ${summary.days}日 = ${summary.total} 室日`}>
                  稼働率 {summary.pct}%
                  <span className="ml-1 font-normal text-xs text-gray-400">（{summary.used}/{summary.total} 室日）</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {setupError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          ⚠ {setupError}
        </div>
      ) : (
        <ReserveLedger year={year} month={month} people={people} onSummary={setSummary} />
      )}
    </div>
  );
}
