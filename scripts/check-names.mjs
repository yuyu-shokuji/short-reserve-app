// 氏名の表記が食事管理アプリ側とそろっているかを調べる（読むだけ。何も書き換えない）。
//
// 将来この予約台帳を食事管理アプリと連動させるとき、people を突き合わせる鍵は氏名しかない。
// 表記がずれていると（空白の種類が違う・旧字と新字が違う等）そこで詰まるので、
// データが少ないうちに洗い出しておく。
//
//   node scripts/check-names.mjs
//   node scripts/check-names.mjs --month=10     … 突き合わせる食事管理側の月（既定は9月）
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');
const RESERVE_ID = process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';
const MEAL_CONFIG_ID = '1zEgwHuqkBoiMKE5WWqGLZSEa7w9ItCw916ne645NvGY';   // 月レジストリの置き場（固定）
const month = Number((process.argv.find(a => a.startsWith('--month=')) ?? '').split('=')[1]) || 9;

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
const sheets = google.sheets({ version: 'v4', auth });

const read = async (id, name) => (await sheets.spreadsheets.values.get({
  spreadsheetId: id, range: `'${name}'`, valueRenderOption: 'UNFORMATTED_VALUE',
})).data.values ?? [];

const cell = (r, i) => String(r?.[i] ?? '').trim();
/** 空白の種類・全角半角の違いを無視した形。これが同じなら「同じ人の表記ゆれ」とみなす。 */
const key = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
const show = (s) => s.replace(/　/g, '〼');   // 全角空白を目に見える形に

// ── 予約台帳側 ────────────────────────────────────────────────
const people = await read(RESERVE_ID, '利用者');
const pHead = (people[0] ?? []).map(c => String(c ?? '').trim());
const pName = pHead.indexOf('氏名'), pFuri = pHead.indexOf('ふりがな');
const rvPeople = people.slice(1).map(r => ({ name: cell(r, pName), furi: pFuri >= 0 ? cell(r, pFuri) : '' }))
  .filter(p => p.name);

const reserve = await read(RESERVE_ID, '予約');
const rHead = (reserve[0] ?? []).map(c => String(c ?? '').trim());
const rName = rHead.indexOf('氏名');
const usedNames = [...new Set(reserve.slice(1).map(r => cell(r, rName)).filter(Boolean))];

// ── 食事管理側（その月のスプレッドシートの「ショート_名」） ──
const reg = await read(MEAL_CONFIG_ID, '月レジストリ');
const row = reg.slice(1).find(r => Number(cell(r, 1)) === month);
if (!row) throw new Error(`月レジストリに ${month}月 がありません`);
const mealNames = await read(cell(row, 2), 'ショート_名');
const mHead = (mealNames[0] ?? []).map(c => String(c ?? '').trim());
const mName = mHead.indexOf('氏名'), mFuri = mHead.indexOf('ふりがな');
const mealPeople = mealNames.slice(1).map(r => ({ name: cell(r, mName), furi: mFuri >= 0 ? cell(r, mFuri) : '' }))
  .filter(p => p.name);

// ── 突き合わせ ────────────────────────────────────────────────
const mealBy = new Map(mealPeople.map(p => [key(p.name), p]));
const rvBy = new Map(rvPeople.map(p => [key(p.name), p]));

const differs = [];     // 同じ人だが書き方が違う
const onlyRv = [];      // 予約台帳にしかいない
const onlyMeal = [];    // 食事管理にしかいない
const furiDiff = [];    // ふりがなが違う／無い

for (const p of rvPeople) {
  const m = mealBy.get(key(p.name));
  if (!m) { onlyRv.push(p); continue; }
  if (m.name !== p.name) differs.push({ rv: p.name, meal: m.name });
  if (!p.furi) furiDiff.push({ name: p.name, rv: '(なし)', meal: m.furi });
  else if (key(p.furi) !== key(m.furi)) furiDiff.push({ name: p.name, rv: p.furi, meal: m.furi });
}
for (const p of mealPeople) if (!rvBy.has(key(p.name))) onlyMeal.push(p);

// 予約シートに出てくる氏名が利用者シートに載っているか（ふりがな順が崩れる原因になる）
const orphan = usedNames.filter(n => !rvBy.has(key(n)));
const notExact = usedNames.filter(n => rvBy.has(key(n)) && !rvPeople.some(p => p.name === n));

const line = (t) => console.log(t);
line(`予約台帳の利用者 ${rvPeople.length}名 ／ 食事管理(${month}月)のショート ${mealPeople.length}名`);
line('');

line(`■ 書き方が違う（同じ人だが文字がそろっていない）… ${differs.length}件`);
differs.forEach(d => line(`   予約台帳「${show(d.rv)}」 ↔ 食事管理「${show(d.meal)}」`));
if (!differs.length) line('   なし');
line('');

line(`■ ふりがながそろっていない … ${furiDiff.length}件`);
furiDiff.slice(0, 20).forEach(d => line(`   ${d.name}：予約台帳「${show(d.rv)}」 ↔ 食事管理「${show(d.meal)}」`));
if (furiDiff.length > 20) line(`   …ほか ${furiDiff.length - 20}件`);
if (!furiDiff.length) line('   なし');
line('');

line(`■ 予約台帳にしかいない … ${onlyRv.length}名`);
onlyRv.slice(0, 20).forEach(p => line(`   ${show(p.name)}`));
if (onlyRv.length > 20) line(`   …ほか ${onlyRv.length - 20}名`);
if (!onlyRv.length) line('   なし');
line('');

line(`■ 食事管理にしかいない … ${onlyMeal.length}名`);
line(`   （その月にショートの登録がある人。予約が入っていないだけのことも多い）`);
onlyMeal.slice(0, 10).forEach(p => line(`   ${show(p.name)}`));
if (onlyMeal.length > 10) line(`   …ほか ${onlyMeal.length - 10}名`);
if (!onlyMeal.length) line('   なし');
line('');

line(`■ 予約シートにあるが利用者シートに無い氏名 … ${orphan.length}件`);
line('   （あいうえお順に並ばなくなるので、利用者シートに足しておくとよい）');
orphan.forEach(n => line(`   ${show(n)}`));
if (!orphan.length) line('   なし');
line('');

line(`■ 予約シートと利用者シートで書き方が違う … ${notExact.length}件`);
notExact.forEach(n => line(`   予約「${show(n)}」 ↔ 利用者「${show(rvBy.get(key(n)).name)}」`));
if (!notExact.length) line('   なし');
line('');
line('※ 〼 は全角スペース。何も書き換えていません。');
