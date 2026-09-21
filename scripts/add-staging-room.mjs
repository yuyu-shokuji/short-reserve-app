// 「部屋」シートに仮置き用の部屋を1つ足す（入れ替え作業の一時置き場）。
// 既存の予約データには触らない。何度実行しても増えない。
//   node scripts/add-staging-room.mjs
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');
const ID = process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';

const STAGING_BUILDING = '仮置き';
const STAGING_ROOM = 1;

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: ID, range: `'部屋'`, valueRenderOption: 'UNFORMATTED_VALUE',
});
const rows = res.data.values ?? [];
if (!rows.length) throw new Error('「部屋」シートが空です');

const head = rows[0].map(c => String(c ?? '').trim());
const width = rows.reduce((m, r) => Math.max(m, r.length), head.length);

// 見出し「仮置き」が無ければ右端に作る（列は見出し名で探す方式）
let sCol = head.indexOf('仮置き');
if (sCol < 0) { sCol = width; head[sCol] = '仮置き'; console.log(`・見出し「仮置き」を列${sCol}に追加`); }

const bCol = head.indexOf('棟'), rCol = head.indexOf('部屋'), nCol = head.indexOf('備考');
if (bCol < 0 || rCol < 0) throw new Error('「棟」「部屋」の見出しが見つかりません');

const grid = [head, ...rows.slice(1).map(r => {
  const rr = [...r];
  while (rr.length <= sCol) rr.push('');
  return rr;
})];

const exists = grid.slice(1).some(r =>
  String(r[bCol] ?? '').trim() === STAGING_BUILDING && Number(r[rCol]) === STAGING_ROOM);

if (exists) {
  console.log('・仮置き部屋はすでにあります（変更なし）');
} else {
  const row = new Array(Math.max(grid[0].length, sCol + 1)).fill('');
  row[bCol] = STAGING_BUILDING;
  row[rCol] = STAGING_ROOM;
  row[sCol] = 'あり';
  if (nCol >= 0) row[nCol] = '入れ替え用の一時置き場（空き部屋数には数えません）';
  grid.push(row);
  console.log('・仮置き部屋を追加しました');
}

await sheets.spreadsheets.values.clear({ spreadsheetId: ID, range: `'部屋'` });
await sheets.spreadsheets.values.update({
  spreadsheetId: ID, range: `'部屋'!A1`, valueInputOption: 'RAW',
  requestBody: { values: grid.map(r => r.map(c => c ?? '')) },
});

console.log(`・部屋シート: ${grid.length - 1}行`);
