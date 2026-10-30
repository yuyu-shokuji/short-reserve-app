// 服薬管理（利用者ごとの決まり）。利用者タブのチェックと、記録表①の服薬管理欄で使う。
//
// シートの「利用者」に「服薬管理」列を1つ持ち、「朝食後・夕食後・点眼朝」のように中黒でつないで入れる。
// 画面と記録表のどちらからも読むので、Googleスプレッドシートに触らない純粋な定義だけを置く。

export const MED_INTERNAL = ['朝食前', '朝食後', '昼食前', '昼食後', '夕食前', '夕食後', '眠前'] as const;
export const MED_EYE = ['点眼朝', '点眼昼', '点眼夕', '点眼眠'] as const;
export const MED_KEYS = [...MED_INTERNAL, ...MED_EYE] as const;
export type MedKey = typeof MED_KEYS[number];

/** シートの文字 → 並び順をそろえたキーの配列。知らない言葉は捨てる。 */
export function parseMeds(s: string): MedKey[] {
  const words = String(s ?? '').split(/[・、,，\s　]+/).filter(Boolean);
  return MED_KEYS.filter(k => words.includes(k));
}

/** キーの配列 → シートに書く文字。 */
export function formatMeds(m: readonly string[]): string {
  return MED_KEYS.filter(k => m.includes(k)).join('・');
}

/**
 * 記録表①の服薬管理欄（Z〜AF列）での列番号。見出し行の並び（朝食前・朝食後…眠前）そのまま。
 * 点眼は同じ列の3行目に〇を付ける（朝→朝食後、昼→昼食後、夕→夕食後、眠→眠前）。
 */
export const MED_COL: Record<MedKey, number> = {
  朝食前: 26, 朝食後: 27, 昼食前: 28, 昼食後: 29, 夕食前: 30, 夕食後: 31, 眠前: 32,   // Z〜AF
  点眼朝: 27, 点眼昼: 29, 点眼夕: 31, 点眼眠: 32,
};

/** どの食事（眠前は「その晩泊まるか」）に付くか。入退所日に〇を付けるかの判定に使う。 */
export const MED_WHEN: Record<MedKey, 'asa' | 'hiru' | 'yu' | 'night'> = {
  朝食前: 'asa', 朝食後: 'asa', 昼食前: 'hiru', 昼食後: 'hiru', 夕食前: 'yu', 夕食後: 'yu', 眠前: 'night',
  点眼朝: 'asa', 点眼昼: 'hiru', 点眼夕: 'yu', 点眼眠: 'night',
};
