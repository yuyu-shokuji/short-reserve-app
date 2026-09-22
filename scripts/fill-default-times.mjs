// 「予約」シートで入所時間・退所時間が空の行に、既定値（入所09:00／退所16:00）を入れる。
// 既に時刻が入っている行には触らない。
//   node scripts/fill-default-times.mjs            … 何件変わるか見るだけ（書き込まない）
//   node scripts/fill-default-times.mjs --apply    … 実際に書き込む
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');
const ID = process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';

const IN_DEFAULT = '09:00';
const OUT_DEFAULT = '16:00';
const apply = process.argv.includes('--apply');

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const colLetter = (c) => { let s = ''; c++; while (c > 0) { c--; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); } return s; };

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: ID, range: `'予約'`, valueRenderOption: 'UNFORMATTED_VALUE',
});
const rows = res.data.values ?? [];
if (rows.length < 2) throw new Error('「予約」シートにデータがありません');

const head = rows[0].map(c => String(c ?? '').trim());
const cName = head.indexOf('氏名');
const cIn = head.indexOf('入所時間');
const cOut = head.indexOf('退所時間');
if (cIn < 0 || cOut < 0) throw new Error('「入所時間」「退所時間」の見出しが見つかりません');

const cell = (r, i) => String(r?.[i] ?? '').trim();
const data = [];
const changed = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (!cell(r, cName)) continue;
  const fixes = [];
  if (!cell(r, cIn))  { fixes.push(['入所', cIn, IN_DEFAULT]); }
  if (!cell(r, cOut)) { fixes.push(['退所', cOut, OUT_DEFAULT]); }
  if (!fixes.length) continue;
  changed.push(`${cell(r, cName)}（行${i + 1}）… ${fixes.map(f => f[0] + '=' + f[2]).join(' / ')}`);
  for (const [, col, val] of fixes) {
    data.push({ range: `'予約'!${colLetter(col)}${i + 1}`, values: [[val]] });
  }
}

console.log(`時刻が空の行: ${changed.length}件 / 全${rows.length - 1}行`);
changed.slice(0, 8).forEach(x => console.log('   ' + x));
if (changed.length > 8) console.log(`   …ほか ${changed.length - 8}件`);

if (!changed.length) { console.log('・入れるものはありませんでした'); process.exit(0); }
if (!apply) { console.log(''); console.log('※ 確認のみ。実際に入れるには --apply を付けて実行してください'); process.exit(0); }

// 1回の batchUpdate でまとめて書く（個別APIのループはクォータ超過＆激遅）
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: ID, requestBody: { valueInputOption: 'RAW', data },
});
console.log('');
console.log(`・${data.length}セルに既定値を入れました`);
