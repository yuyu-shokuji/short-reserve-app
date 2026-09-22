// 「予約」シートの送迎を入所時・退所時の2つに分ける。
//   既存の「送迎」→「退所送迎」に改名し、「入所時間」の右に「入所送迎」を新設。
//   いまのデータは入所・退所とも同じ値を入れる（分ける前は1つだったため）。
// 何度実行しても増えない。
//   node scripts/split-soutai.mjs            … 確認のみ
//   node scripts/split-soutai.mjs --apply    … 実際に直す
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');
const ID = process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';
const apply = process.argv.includes('--apply');

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });
const colLetter = (c) => { let s = ''; c++; while (c > 0) { c--; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); } return s; };

const readSheet = async () => (await sheets.spreadsheets.values.get({
  spreadsheetId: ID, range: `'予約'`, valueRenderOption: 'UNFORMATTED_VALUE',
})).data.values ?? [];

let rows = await readSheet();
let head = (rows[0] ?? []).map(c => String(c ?? '').trim());
console.log('いまの見出し: ' + head.join(' / '));

if (head.includes('入所送迎') && head.includes('退所送迎')) {
  console.log('・すでに分かれています（変更なし）');
  process.exit(0);
}
if (!apply) {
  console.log('');
  console.log('やること: 「送迎」→「退所送迎」に改名し、「入所時間」の右に「入所送迎」を新設して同じ値を入れる');
  console.log('※ 確認のみ。実行するには --apply を付けてください');
  process.exit(0);
}

const meta = await sheets.spreadsheets.get({ spreadsheetId: ID, fields: 'sheets.properties' });
const sheetId = (meta.data.sheets ?? []).find(s => s.properties?.title === '予約')?.properties?.sheetId;
if (sheetId == null) throw new Error('「予約」シートが見つかりません');

// 1) 「送迎」→「退所送迎」
const oldIdx = head.indexOf('送迎');
if (oldIdx >= 0) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: ID, range: `'予約'!${colLetter(oldIdx)}1`,
    valueInputOption: 'RAW', requestBody: { values: [['退所送迎']] },
  });
  console.log(`・「送迎」→「退所送迎」に改名（列${colLetter(oldIdx)}）`);
}

// 2) 「入所時間」の右に空の列を1つ入れる（人が見たときに並びが自然になるように）
rows = await readSheet();
head = (rows[0] ?? []).map(c => String(c ?? '').trim());
const at = head.indexOf('入所時間') + 1;
if (at <= 0) throw new Error('「入所時間」の見出しが見つかりません');
await sheets.spreadsheets.batchUpdate({
  spreadsheetId: ID,
  requestBody: { requests: [{ insertDimension: {
    range: { sheetId, dimension: 'COLUMNS', startIndex: at, endIndex: at + 1 },
    inheritFromBefore: false,
  } }] },
});
console.log(`・列${colLetter(at)}に新しい列を追加`);

// 3) 見出しを書き、退所送迎と同じ値を入れる
rows = await readSheet();
head = (rows[0] ?? []).map(c => String(c ?? '').trim());
const outIdx = head.indexOf('退所送迎');
const cell = (r, i) => String(r?.[i] ?? '').trim();
const data = [{ range: `'予約'!${colLetter(at)}1`, values: [['入所送迎']] }];
let copied = 0;
for (let i = 1; i < rows.length; i++) {
  const v = outIdx >= 0 ? cell(rows[i], outIdx) : '';
  if (!v) continue;
  data.push({ range: `'予約'!${colLetter(at)}${i + 1}`, values: [[v]] });
  copied++;
}
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: ID, requestBody: { valueInputOption: 'RAW', data },
});

const after = (await readSheet())[0].map(c => String(c ?? '').trim());
console.log(`・「入所送迎」を作り、退所送迎と同じ値を ${copied}行 にコピーしました`);
console.log('新しい見出し: ' + after.join(' / '));
