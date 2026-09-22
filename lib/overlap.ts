// 同じ部屋の2件が本当にぶつかるかどうかの判定。
// 画面（チャートの赤表示）と保存前チェックの両方から使うので、
// Googleスプレッドシートに触らない純粋な関数だけを置く。
//
// ポイントは「退所日と入所日が同じ日でも、時刻しだいで入れ替われるとは限らない」こと。
//   例）さくら01 を 11:00 に退所 → 13:00 入所の人はOK、10:00 入所の人はNG。

import { minutesOf } from './meal-rule';

export interface Span {
  start: string; end: string;      // YYYY-MM-DD
  inTime: string; outTime: string; // HH:MM（空のことがある）
}

export type OverlapKind =
  | 'none'               // 重ならない
  | 'handover-ok'        // 同日交代で時刻も問題なし
  | 'handover-clash'     // 同日交代だが、前の人の退所より先に次の人が入る
  | 'handover-unknown'   // 同日交代だが、時刻が未入力で確かめられない
  | 'overlap';           // 期間がまるごと重なっている

const dayList = (s: string, e: string): string[] => {
  const out: string[] = [];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const n = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e);
  if (!m || !n) return out;
  const cur = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const last = new Date(Number(n[1]), Number(n[2]) - 1, Number(n[3]));
  while (cur <= last && out.length < 400) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
};

/** 重なっている日（両端を含む） */
export function overlapDaysOf(a: Span, b: Span): string[] {
  const s = a.start > b.start ? a.start : b.start;
  const e = a.end < b.end ? a.end : b.end;
  return s <= e ? dayList(s, e) : [];
}

export interface OverlapResult {
  kind: OverlapKind;
  days: string[];
  /** 同日交代のとき、どちらが出てどちらが入るか */
  handover?: { out: Span; outTime: string; in: Span; inTime: string; day: string };
}

/** 同じ部屋の2件がぶつかるかどうかを、日付と時刻の両方から判定する。 */
export function classifyOverlap(a: Span, b: Span): OverlapResult {
  const days = overlapDaysOf(a, b);
  if (!days.length) return { kind: 'none', days };
  if (days.length > 1) return { kind: 'overlap', days };

  const d = days[0];
  // 片方の退所日＝もう片方の入所日 のときだけ入れ替われる可能性がある。
  // 両方が同じ日に始まる／終わるなら、それは単なる重なり。
  let leaving: Span | null = null, arriving: Span | null = null;
  if (a.end === d && b.start === d && a.start !== d) { leaving = a; arriving = b; }
  else if (b.end === d && a.start === d && b.start !== d) { leaving = b; arriving = a; }
  else if (a.end === d && b.start === d && b.end !== d) { leaving = a; arriving = b; }
  else if (b.end === d && a.start === d && a.end !== d) { leaving = b; arriving = a; }
  if (!leaving || !arriving) return { kind: 'overlap', days };

  const out = minutesOf(leaving.outTime);
  const inn = minutesOf(arriving.inTime);
  const hv = { out: leaving, outTime: leaving.outTime, in: arriving, inTime: arriving.inTime, day: d };
  if (out === null || inn === null) return { kind: 'handover-unknown', days, handover: hv };
  // 前の人が出てから次の人が入るならOK（同時刻ちょうどは可とする）
  return { kind: out <= inn ? 'handover-ok' : 'handover-clash', days, handover: hv };
}

/** 保存してよいか（重なりとして知らせるべきか） */
export const isBlocking = (k: OverlapKind) =>
  k === 'overlap' || k === 'handover-clash' || k === 'handover-unknown';
