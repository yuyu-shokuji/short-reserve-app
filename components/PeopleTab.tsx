'use client';

// 「利用者」タブ。新しい利用者を足す・服薬管理などを直す。足した人は予約の氏名の候補に出る。
//
// ⚠️ 試験運用のあいだだけの入口（2026-10-30 現場の指定）。本来の利用者名簿は食事管理アプリにある。
//    統合するときは、ここで足した人（登録日時が入っている人）のうち向こうとダブった人を消す。
//    服薬管理は記録表①の「服薬管理」欄に〇で出る（lib/record-sheet.ts）。

import { useMemo, useState } from 'react';
import type { Person } from './ReserveApp';
import { MED_INTERNAL, MED_EYE, formatMeds, type MedKey } from '@/lib/meds';

interface Draft { name: string; furi: string; contact: string; note: string; meds: MedKey[] }
const blank: Draft = { name: '', furi: '', contact: '', note: '', meds: [] };

export default function PeopleTab({ people, onSaved }: {
  people: Person[];
  onSaved: (p: Person, isNew: boolean) => void;
}) {
  const [f, setF] = useState<Draft>(blank);
  // 編集中の人の氏名。空なら新規追加。
  const [editing, setEditing] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');

  // 同じ人がもういないか、打っているそばから知らせる（空白の違いは無視）
  const key = (s: string) => s.replace(/[\s　]+/g, '');
  const dup = !editing && f.name.trim() ? people.find(p => key(p.name) === key(f.name)) : undefined;

  const startEdit = (p: Person) => {
    setEditing(p.name);
    setF({ name: p.name, furi: p.furi, contact: p.contact, note: p.note, meds: p.meds ?? [] });
    setError(''); setMsg('');
  };
  const startNew = () => { setEditing(''); setF(blank); setError(''); setMsg(''); };

  const toggleMed = (k: MedKey) =>
    setF(d => ({ ...d, meds: d.meds.includes(k) ? d.meds.filter(x => x !== k) : [...d.meds, k] }));

  const save = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const res = await fetch('/api/people', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing ? { ...f, name: editing } : f),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? '保存できませんでした');
      onSaved(j.person, !editing);
      if (editing) {
        setMsg(`${j.person.name} さんの情報を保存しました。`);
        setF({ ...f, meds: j.person.meds ?? [] });
      } else {
        setMsg(`${j.person.name} さんを追加しました。予約の氏名の候補に出ます。`);
        setF(blank);
      }
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
  const medBox = (k: MedKey, label: string) => (
    <label key={k} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs cursor-pointer select-none ${
      f.meds.includes(k) ? 'bg-emerald-50 border-emerald-400 text-emerald-900 font-bold' : 'border-gray-200 text-gray-600'}`}>
      <input type="checkbox" checked={f.meds.includes(k)} onChange={() => toggleMed(k)} className="accent-emerald-600" />
      {label}
    </label>
  );

  return (
    <div className="grid gap-3 md:grid-cols-[380px_1fr] items-start">
      {/* 追加・編集 */}
      <div className={`bg-white rounded-xl border shadow-sm p-4 space-y-3 ${editing ? 'border-sky-300' : 'border-emerald-200'}`}>
        <div className="flex items-center gap-2">
          <h2 className="font-bold text-gray-800">{editing ? '✏️ 利用者の情報を直す' : '＋ 新しい利用者を追加'}</h2>
          {editing && (
            <button onClick={startNew} className="ml-auto text-xs text-sky-600 underline">新しい人を追加する</button>
          )}
        </div>
        <p className="text-xs text-gray-500">
          {editing
            ? '一覧で選んだ人を直しています。氏名は予約とつながっているので、ここでは変えられません。'
            : '試験運用中の仮の入口です。食事管理アプリと統合するときに、ダブった人は整理します。一覧の名前を押すと、その人の情報を直せます。'}
        </p>
        <label className="block text-xs text-gray-600 space-y-1">
          <span className="font-semibold">氏名 {!editing && <span className="text-red-600">必須</span>}</span>
          <input value={f.name} readOnly={!!editing} onChange={e => setF({ ...f, name: e.target.value })}
            className={`${input} ${editing ? 'bg-gray-50 text-gray-700 font-bold' : ''}`}
            placeholder="例）山田　花子（姓と名の間は空ける）" />
        </label>
        {dup && <p className="text-xs font-bold text-amber-700">⚠ 「{dup.name}」さんはもう登録されています（一覧で名前を押すと直せます）</p>}
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

        {/* 服薬管理。チェックした所が記録表①の服薬管理欄に〇で出る。 */}
        <fieldset className="space-y-1.5 rounded-lg border border-gray-200 p-2.5">
          <legend className="px-1 text-xs font-semibold text-gray-600">服薬管理（記録表①に〇で出ます）</legend>
          <div className="flex flex-wrap gap-1.5">{MED_INTERNAL.map(k => medBox(k, k))}</div>
          <div className="flex flex-wrap gap-1.5">{MED_EYE.map(k => medBox(k, k.replace('点眼', '点眼 ')))}</div>
        </fieldset>

        <button onClick={save} disabled={busy || !f.name.trim() || !f.furi.trim() || !!dup}
          className={`w-full text-white rounded-lg py-2 font-bold disabled:opacity-40 ${
            editing ? 'bg-sky-600 hover:bg-sky-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
          {busy ? '保存中…' : editing ? '保存する' : '追加する'}
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
                <th className="text-left px-3 py-1.5">服薬管理</th>
                <th className="text-left px-3 py-1.5">連絡先</th><th className="text-left px-3 py-1.5">備考</th>
                <th className="text-left px-3 py-1.5">追加</th>
              </tr>
            </thead>
            <tbody>
              {list.map(p => (
                <tr key={p.name} onClick={() => startEdit(p)} title="押すと、この人の情報を直せます"
                  className={`border-t border-gray-50 cursor-pointer hover:bg-sky-50 ${
                    editing === p.name ? 'bg-sky-100' : p.added ? 'bg-emerald-50/60' : ''}`}>
                  <td className="px-3 py-1.5 font-semibold text-gray-800 whitespace-nowrap">{p.name}</td>
                  <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{p.furi}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-700">{formatMeds(p.meds ?? [])}</td>
                  <td className="px-3 py-1.5 text-gray-600">{p.contact}</td>
                  <td className="px-3 py-1.5 text-gray-600">{p.note}</td>
                  <td className="px-3 py-1.5 text-xs text-emerald-700 whitespace-nowrap">
                    {p.added ? `この画面で追加（${p.added}）` : ''}
                  </td>
                </tr>
              ))}
              {!list.length && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">見つかりません</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
