// 送迎の区分。画面（選択肢・表の時刻）・保存・記録表のどこからも使うので、ここに1つだけ置く。
//
// 送迎なしはあり得ないので空は選べない（以前「なし」で入れた予約だけ空のまま残っている）。
// 2026-10-30 現場の指定で4択に：送迎あり／家族送迎(FA)／デイ送迎(DS)／他デイ送迎(他DS)。
// 送迎あり以外は、表の時刻の前に略号を付ける（例「FA 09:00」「DS 16:00」）。

export const SOUTAI_KINDS = ['送迎あり', '家族送迎', 'デイ送迎', '他デイ送迎'] as const;
export type SoutaiKind = '' | typeof SOUTAI_KINDS[number];

/** 時刻の前に付ける略号。送迎ありは付けない。 */
export const SOUTAI_ABBR: Record<SoutaiKind, string> = {
  '': '', 送迎あり: '', 家族送迎: 'FA', デイ送迎: 'DS', 他デイ送迎: '他DS',
};

/** 選択肢に出す名前。 */
export const SOUTAI_LABEL: Record<typeof SOUTAI_KINDS[number], string> = {
  送迎あり: '送迎あり', 家族送迎: '家族送迎（FA）', デイ送迎: 'デイ送迎（DS）', 他デイ送迎: '他デイ送迎（他DS）',
};

/** 画面やシートから来た値を4択（か空）にそろえる。知らない値は空。 */
export function normSoutai(v: unknown): SoutaiKind {
  const s = String(v ?? '').trim();
  return (SOUTAI_KINDS as readonly string[]).includes(s) ? (s as SoutaiKind) : '';
}

/**
 * シートの文字から区分を読む。手で書かれた揺れ（「家族」「他デイ」など）も拾う。
 * ⚠️ 「他デイ」を「デイ」より先に見ること（「他デイ送迎」にも「デイ」が含まれるため）。
 */
export function parseSoutai(v: unknown): SoutaiKind {
  const s = String(v ?? '').trim();
  if (!s || s === 'なし') return '';
  if (s.includes('家族') || s === 'FA') return '家族送迎';
  if (s.includes('他デイ') || s.includes('他DS')) return '他デイ送迎';
  if (s.includes('デイ') || s === 'DS') return 'デイ送迎';
  return '送迎あり';
}

/** 表に出す時刻。送迎あり以外は略号を前に付ける。 */
export const withAbbr = (s: SoutaiKind, t: string) => (SOUTAI_ABBR[s] ? `${SOUTAI_ABBR[s]} ${t}` : t);
