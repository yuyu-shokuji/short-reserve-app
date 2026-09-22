'use client';

// アプリの外枠。ヘッダーと月送りだけを持ち、中身は ReserveLedger。

import { useCallback, useEffect, useState } from 'react';
import ReserveLedger from './ReserveLedger';

export interface Person { name: string; furi: string; contact: string; note: string; }

export default function ReserveApp() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [people, setPeople] = useState<Person[]>([]);
  const [setupError, setSetupError] = useState('');

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
    <div className="w-full px-2 py-4 mx-auto space-y-4">
      <div className="rsv-noprint bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
        <div className="flex items-center gap-3 justify-between flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🛏</span>
            <div>
              <h1 className="text-xl font-bold text-gray-800">ショート予約台帳</h1>
              <p className="text-sm text-gray-500">グラン悠遊</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => shiftMonth(-1)}
              className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 font-bold hover:bg-gray-200">◀</button>
            <span className="px-3 font-bold text-gray-800 tabular-nums text-lg">{year}年{month}月</span>
            <button onClick={() => shiftMonth(1)}
              className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 font-bold hover:bg-gray-200">▶</button>
            {!isThisMonth && (
              <button onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth() + 1); }}
                className="ml-2 px-2 py-1 text-xs text-sky-600 underline">今月へ</button>
            )}
          </div>
        </div>
      </div>

      {setupError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          ⚠ {setupError}
        </div>
      ) : (
        <ReserveLedger year={year} month={month} people={people} />
      )}
    </div>
  );
}
