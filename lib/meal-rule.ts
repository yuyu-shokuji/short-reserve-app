// 入退所の時刻から、その日に出す食事を決めるルール。
//
// ★このファイルだけ直せばルールを変えられるようにしてある（今後変わる前提のため）。
// 画面（チャート）も食数の見せ方もここの判定を使う。
//
// 現場のルール（2026-09-22 時点。退所日の夕食は 2026-10-30 に 18:30 へ変更）
//   入所日 … 朝食は出さない（何時に来ても）
//            13:00 以降 → 夕のみ ／ それより前 → 昼・夕
//   退所日 … 11:30 まで          → 朝のみ
//            11:30 超 18:29 まで → 朝・昼
//            18:30 以降          → 朝・昼・夕
//   中日   … 朝・昼・夕
//   おやつ … 昼と連動（昼が出る日は出る）
//
// 時刻が決まっていないことが多いので、時刻のかわりに「午前」「午後」も入れられる（2026-10-30）。
//   入所 午前 → 昼・夕 ／ 午後 → 夕のみ
//   退所 午前 → 朝のみ ／ 午後 → 朝・昼
//   新しい予約の既定は 入所＝午前・退所＝午後。
//
// 食事の無いマスは「薄字で名前」ではなく空にする。その部屋はその食事の時間帯には
// 空いていて、次の人を受け入れられるため（＝チャート上も空きとして見えてほしい）。
//
// 時刻が空のときは、入所日＝昼夕／退所日＝朝昼 を既定にする。

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

/** 時刻のかわりに入れられる、おおまかな時間帯。 */
export const AM = '午前', PM = '午後';
export const isAmPm = (t: string) => t === AM || t === PM;

/**
 * 時刻がとりうる範囲（分）。"HH:MM" ならその1点、午前＝0:00〜11:59、午後＝12:00〜23:59。
 * 空や不正なら null。同日交代のチェック（lib/overlap.ts）で使う。
 */
export function rangeOf(t: string): [number, number] | null {
  const v = String(t ?? '').trim();
  if (v === AM) return [0, HH(11, 59)];
  if (v === PM) return [HH(12), HH(23, 59)];
  const m = minutesOf(v);
  return m === null ? null : [m, m];
}

/** 退所日に出す食事。18:30より前なら夕は不要、11:30以前なら昼も不要。 */
export function mealsOnCheckout(outTime: string): Meals {
  const v = String(outTime ?? '').trim();
  if (v === AM) return { asa: true, hiru: false, yu: false };
  if (v === PM) return { asa: true, hiru: true, yu: false };
  const t = minutesOf(v);
  if (t === null) return { asa: true, hiru: true, yu: false };   // 時刻未入力＝夕は出さない
  if (t <= HH(11, 30)) return { asa: true, hiru: false, yu: false };
  if (t < HH(18, 30)) return { asa: true, hiru: true, yu: false };
  return { ...ALL };
}

/** 入所日に出す食事。入所日は朝食を食べない。13:00以降の入所なら昼も不要。 */
export function mealsOnCheckin(inTime: string): Meals {
  const v = String(inTime ?? '').trim();
  if (v === AM) return { asa: false, hiru: true, yu: true };
  if (v === PM) return { asa: false, hiru: false, yu: true };
  const t = minutesOf(v);
  if (t !== null && t >= HH(13)) return { asa: false, hiru: false, yu: true };
  return { asa: false, hiru: true, yu: true };
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

// ── おやつ ───────────────────────────────────────────────────────────
// 2026-09-22 現場確認：**おやつは昼と連動する**（昼が出る日は出る）。
//
// チャートは食事管理アプリの全体一覧に合わせて「1部屋＝朝・昼・夕の3行」なので、
// おやつは Meals（＝チャートの行）には入れていない。行を増やすと表が崩れるため。
// 食事管理アプリの「ショート_記録」へ書き出すときに、下の関数で足す。
//
// ⚠️ 全体行事で別業者から調達する日（イベント）は、ここでは扱わない。
//    食事管理アプリの「イベント」シートに 日付 | ショート | おやつ の行を入れると、
//    厨房アプリが集計から外す仕組みがすでにある（meal-app/lib/events.ts）。
//    そちらは「利用者の食べる/食べないの記録はそのまま残す」決まりなので、
//    書き出すときにイベントを気にする必要はない。

/** その日おやつを出すか。昼と連動する。 */
export function oyatsuOf(m: Meals): boolean {
  return m.hiru;
}

/** 朝・昼・おやつ・夕の4つ。「ショート_記録」へ書き出すときの形。 */
export interface MealsAll extends Meals { oyatsu: boolean }

/** ある予約の、ある日に出す食事（おやつ込み）。 */
export function mealsAllFor(
  r: { start: string; end: string; inTime: string; outTime: string },
  iso: string,
): MealsAll {
  const m = mealsFor(r, iso);
  return { ...m, oyatsu: oyatsuOf(m) };
}

export const MEAL_ALL_LABEL: Record<keyof MealsAll, string> = {
  asa: '朝', hiru: '昼', oyatsu: 'おやつ', yu: '夕',
};
