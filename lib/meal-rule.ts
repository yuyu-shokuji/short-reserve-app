// 入退所の時刻から、その日に出す食事を決めるルール。
//
// ★このファイルだけ直せばルールを変えられるようにしてある（今後変わる前提のため）。
// 画面（チャート）も食数の見せ方もここの判定を使う。
//
// 現場のルール（2026-09-22 時点）
//   退所日 … 11:00 まで          → 朝のみ
//            11:00 超 16:00 まで → 朝・昼
//            16:00 超            → 朝・昼・夕
//   入所日 … 13:00 以降          → 夕のみ
//            11:00 以降          → 昼・夕
//            11:00 より前        → 朝・昼・夕
//   中日   … 朝・昼・夕
//
// 時刻が空のときは、従来の現場ルール（入所日は朝を出さない／退所日は夕を出さない）を既定にする。

export type MealKey = 'asa' | 'hiru' | 'yu';
export const MEAL_KEYS: MealKey[] = ['asa', 'hiru', 'yu'];
export type Meals = Record<MealKey, boolean>;

const ALL: Meals = { asa: true, hiru: true, yu: true };
const NONE: Meals = { asa: false, hiru: false, yu: false };

/** "HH:MM" → 分。空や不正なら null。 */
export function minutesOf(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

const HH = (h: number, m = 0) => h * 60 + m;

/** 退所日に出す食事 */
export function mealsOnCheckout(outTime: string): Meals {
  const t = minutesOf(outTime);
  if (t === null) return { asa: true, hiru: true, yu: false };   // 時刻未入力＝夕は出さない
  if (t <= HH(11)) return { asa: true, hiru: false, yu: false };
  if (t <= HH(16)) return { asa: true, hiru: true, yu: false };
  return { ...ALL };
}

/** 入所日に出す食事 */
export function mealsOnCheckin(inTime: string): Meals {
  const t = minutesOf(inTime);
  if (t === null) return { asa: false, hiru: true, yu: true };   // 時刻未入力＝朝は出さない
  if (t >= HH(13)) return { asa: false, hiru: false, yu: true };
  if (t >= HH(11)) return { asa: false, hiru: true, yu: true };
  return { ...ALL };
}

const and = (a: Meals, b: Meals): Meals => ({
  asa: a.asa && b.asa, hiru: a.hiru && b.hiru, yu: a.yu && b.yu,
});

/**
 * ある予約の、ある日に出す食事。
 * 初日かつ最終日（単日利用）のときは両方の条件を満たすものだけ出す。
 * 例）9:00入所・16:00退所 → 入所[朝昼夕]∩退所[朝昼] = 朝・昼
 */
export function mealsFor(
  r: { start: string; end: string; inTime: string; outTime: string },
  iso: string,
): Meals {
  if (iso < r.start || iso > r.end) return { ...NONE };
  const isFirst = iso === r.start;
  const isLast = iso === r.end;
  if (isFirst && isLast) return and(mealsOnCheckin(r.inTime), mealsOnCheckout(r.outTime));
  if (isFirst) return mealsOnCheckin(r.inTime);
  if (isLast) return mealsOnCheckout(r.outTime);
  return { ...ALL };
}

export const MEAL_LABEL: Record<MealKey, string> = { asa: '朝', hiru: '昼', yu: '夕' };
