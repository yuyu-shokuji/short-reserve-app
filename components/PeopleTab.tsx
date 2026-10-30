'use client';

// 「利用者」タブ。新しい利用者を足して、予約の氏名の候補に出せるようにする。
//
// ⚠️ 試験運用のあいだだけの入口（2026-10-30 現場の指定）。本来の利用者名簿は食事管理アプリにある。
//    統合するときは、ここで足した人（登録日時が入っている人）のうち向こうとダブった人を消す。

import { useMemo, useState } from 'react';
import type { Person } from './ReserveApp';

const blank = { name: '', furi: '', contact: '', note: '' };

export default function PeopleTab({ people, onAdded }: { people: Person[]; onAdded: (p: Person) => void }) {
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');

  // 同じ人がもういないか、打っているそばから知らせる（空白の違いは無視）
  const key = (s: string) => s.replace(/[\s　]+/g, '');
  const dup = f.name.trim() ? people.find(p => key(p.name) === key(f.name)) : undefined;

  const add = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const res = await fetch('/api/people', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '追加できませんでした');
      onAdded(j.person);
      setMsg(`${j.person.name} さんを追加しました。予約の氏名の候補に出ます。`);
      setF(blank);
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  const list = useMemo(() => {
    const k = key(q);
    return [...people]
      .filter(p => !k || key(p.name).includes(k) || key(p.furi).includes(k))
      .sort((a, b) => a.furi.localeCompare(b.furi, 'ja'));
  }, [people, q]);
  const addedCount = people.filter(p => p.added).length;

  const input = 'w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm';
  return (
    <div className="grid gap-3 md:grid-cols-[360px_1fr] items-start">
      {/* 追加 */}
      <div className="bg-white rounded-xl border border-emerald-200 shadow-sm p-4 space-y-3">
        <h2 className="font-bold text-gray-800">＋ 新しい利用者を追加</h2>
        <p className="text-xs text-gray-500">
          試験運用中の仮の入口です。食事管理アプリと統合するときに、ダブった人は整理します。
        </p>
        <label className="block text-xs text-gray-600 space-y-1">
          <span className="font-semibold">氏名 <span className="text-red-600">必須</span></span>
          <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })}
            className={input} placeholder="例）山田　花子（姓と名の間は空ける）" />
        </label>
        {dup && <p className="text-xs font-bold text-amber-700">⚠ 「{dup.name}」さんはもう登録されています</p>}
        <label className="block text-xs text-gray-600 space-y-1">
          <span className="font-semibold">ふりがな <span className="text-red-600">必須</span></span>
          <input value={f.furi} onChange={e => setF({ ...f, furi: e.target.value })}
            className={input} placeholder="例）やまだ　はなこ" />
        </label>
        <label className="block text-xs text-gray-600 space-y-1">
          <span className="font-semibold">連絡先</span>
          <input value={f.contact} onChange={e => setF({ ...f, contact: e.target.value })} className={input} />
        </label>
        <label className="block text-xs text-gray-600 space-y-1">
          <span className="font-semibold">備考</span>
          <input value={f.note} onChange={e => setF({ ...f, note: e.target.value })} className={input} />
        </label>
        <button onClick={add} disabled={busy || !f.name.trim() || !f.furi.trim() || !!dup}
          className="w-full bg-emerald-600 text-white rounded-lg py-2 font-bold hover:bg-emerald-700 disabled:opacity-40">
          {busy ? '追加中…' : '追加する'}
        </button>
        {msg && <p className="text-sm text-emerald-700 font-semibold">{msg}</p>}
        {error && <p className="text-sm text-red-700 font-semibold">⚠ {error}</p>}
      </div>

      {/* 一覧 */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-3 py-2 border-b border-gray-100 flex-wrap">
          <span className="font-bold text-gray-800">利用者一覧</span>
          <span className="text-xs text-gray-500 tabular-nums">
            {people.length}名（うちこの画面で追加 {addedCount}名）
          </span>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="氏名・ふりがなで探す"
            className="ml-auto border border-gray-200 rounded-md px-2 py-1 text-sm w-56" />
        </div>
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-3 py-1.5">氏名</th><th className="text-left px-3 py-1.5">ふりがな</th>
                <th className="text-left px-3 py-1.5">連絡先</th><th className="text-left px-3 py-1.5">備考</th>
                <th className="text-left px-3 py-1.5">追加</th>
              </tr>
            </thead>
            <tbody>
              {list.map(p => (
                <tr key={p.name} className={`border-t border-gray-50 ${p.added ? 'bg-emerald-50/60' : ''}`}>
                  <td className="px-3 py-1.5 font-semibold text-gray-800 whitespace-nowrap">{p.name}</td>
                  <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{p.furi}</td>
                  <td className="px-3 py-1.5 text-gray-600">{p.contact}</td>
                  <td className="px-3 py-1.5 text-gray-600">{p.note}</td>
                  <td className="px-3 py-1.5 text-xs text-emerald-700 whitespace-nowrap">
                    {p.added ? `この画面で追加（${p.added}）` : ''}
                  </td>
                </tr>
              ))}
              {!list.length && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-400">見つかりません</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
