// 「予約」シートの見出しを付け替える。
//   迎え時間 → 入所時間 ／ 送り時間 → 退所時間
// 入退所の時間は送迎の有無と関係なく必要、という整理に合わせたもの。
// 中身（各行の値）はそのまま。何度実行しても安全。
//   node scripts/rename-time-columns.mjs
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');
const ID = process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';

const RENAME = { '迎え時間': '入所時間', '送り時間': '退所時間' };

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: ID, range: `'予約'!1:1`, valueRenderOption: 'UNFORMATTED_VALUE',
});
const head = (res.data.values ?? [[]])[0].map(c => String(c ?? '').trim());
if (!head.length) throw new Error('「予約」シートの見出し行が読めません');

let changed = 0;
const next = head.map(h => {
  if (RENAME[h]) { console.log(`・「${h}」→「${RENAME[h]}」`); changed++; return RENAME[h]; }
  return h;
});

if (!changed) {
  console.log('・付け替える見出しはありませんでした（すでに変更ずみ）');
  console.log(`・現在の見出し: ${head.join(' / ')}`);
} else {
  await sheets.spreadsheets.values.update({
    spreadsheetId: ID, range: `'予約'!1:1`, valueInputOption: 'RAW', requestBody: { values: [next] },
  });
  console.log(`・見出しを更新しました: ${next.join(' / ')}`);
}
