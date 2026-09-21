'use client';

// アプリの外枠。月の切り替えは「予約台帳」と「書き出し確認」で共有する
// （台帳で11月を見てから確認タブに移ると、そのまま11月の月シートが出る）。

import { useCallback, useEffect, useState } from 'react';
import ReserveLedger from './ReserveLedger';
import MonthOverview from './MonthOverview';

type Tab = 'ledger' | 'check';

export default function ReserveApp() {
  const now = new Date();
  const [year, setYear]   = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [tab, setTab]     = useState<Tab>('ledger');
  const [occupants, setOccupants] = useState<string[]>([]);

  // 氏名の候補（ショート_名）。1回読めば十分なので起動時だけ。
  useEffect(() => {
    fetch('/api/roster', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (Array.isArray(j.occupants)) setOccupants(j.occupants); })
      .catch(() => {});
  }, []);

  const shiftMonth = useCallback((delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }, [year, month]);

  const isThisMonth = year === now.getFullYear() && month === now.getMonth() + 1;

  const tabCls = (t: Tab) =>
    `flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
      tab === t ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`;

  return (
    <div className="w-full px-2 py-4 mx-auto space-y-4">
      <div className="rsv-noprint bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
        <div className="flex items-center gap-3 justify-between flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🛏</span>
            <div>
              <h1 className="text-xl font-bold text-gray-800">ショート予約台帳</h1>
              <p className="text-sm text-gray-500">メゾン悠遊</p>
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

      <div className="rsv-noprint flex rounded-2xl bg-gray-100 p-1 gap-1">
        <button onClick={() => setTab('ledger')} className={tabCls('ledger')}>🗂 予約台帳</button>
        <button onClick={() => setTab('check')} className={tabCls('check')}>📋 書き出し確認</button>
      </div>

      {tab === 'ledger' && <ReserveLedger year={year} month={month} occupants={occupants} />}
      {tab === 'check'  && <MonthOverview year={year} month={month} />}
    </div>
  );
}
