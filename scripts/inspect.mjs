// 指定スプレッドシートの中身をざっと見る（読み取りだけ）。
//   node scripts/inspect.mjs <スプレッドシートID>
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');

const id = process.argv[2];
if (!id) throw new Error('スプレッドシートIDを渡してください');

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'properties.title,sheets.properties' });
console.log(`タイトル: ${meta.data.properties.title}`);
for (const s of meta.data.sheets) {
  const t = s.properties.title;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: id, range: `'${t}'`, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values ?? [];
  const filled = rows.filter(r => r.some(c => String(c ?? '').trim()));
  console.log(`  - 「${t}」 データのある行: ${filled.length}`);
  filled.slice(0, 3).forEach(r => console.log(`      ${JSON.stringify(r).slice(0, 120)}`));
}
