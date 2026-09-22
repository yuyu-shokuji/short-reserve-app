// 見出し名を指定して、いらなくなった列を1つ消す。
//
// 列の作り替えをしたあと、古い見出しが端に残ってしまうことがある。
// アプリは見出し名で列を探すので残っていても動くが、人が見たときに紛らわしいので片づける。
//
//   node scripts/drop-column.mjs --sheet=予約 --col=送迎              … 何が消えるか見るだけ
//   node scripts/drop-column.mjs --sheet=予約 --col=送迎 --apply      … 実際に消す
//   （--id=<ID> で対象のスプレッドシートを切り替えられる）
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');
const arg = (n) => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? '').split('=')[1] ?? '';
const ID = arg('id') || process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';
const SHEET = arg('sheet');
const COL = arg('col');
const apply = process.argv.includes('--apply');

if (!SHEET || !COL) { console.log('--sheet=<シート名> --col=<見出し名> を指定してください'); process.exit(1); }

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });
const colLetter = (c) => { let s = ''; c++; while (c > 0) { c--; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); } return s; };

const meta = await sheets.spreadsheets.get({ spreadsheetId: ID, fields: 'properties.title,sheets.properties' });
const sheetId = (meta.data.sheets ?? []).find(s => s.properties?.title === SHEET)?.properties?.sheetId;
if (sheetId == null) throw new Error(`「${SHEET}」シートが見つかりません`);

const rows = (await sheets.spreadsheets.values.get({
  spreadsheetId: ID, range: `'${SHEET}'`, valueRenderOption: 'UNFORMATTED_VALUE',
})).data.values ?? [];
const head = (rows[0] ?? []).map(c => String(c ?? '').trim());
const at = head.indexOf(COL);

console.log(`対象： ${meta.data.properties.title} ／ シート「${SHEET}」`);
console.log(`見出し： ${head.join(' / ')}`);
console.log('');

if (at < 0) { console.log(`・「${COL}」という見出しはありません（変更なし）`); process.exit(0); }

const kept = rows.slice(1)
  .map((r, i) => [i + 2, String(r?.[at] ?? '').trim()])
  .filter(([, v]) => v);
console.log(`・列${colLetter(at)}「${COL}」を消します`);
console.log(`・その列に値が入っている行： ${kept.length}件`);
kept.slice(0, 10).forEach(([n, v]) => console.log(`     行${n}： ${v}`));
if (kept.length > 10) console.log(`     …ほか ${kept.length - 10}件`);

if (!apply) {
  console.log('');
  console.log('※ 確認のみ。実際に消すには --apply を付けてください');
  console.log('※ 消すと元に戻せません。値が残っている場合は、先に移し先を確かめること');
  process.exit(0);
}

await sheets.spreadsheets.batchUpdate({
  spreadsheetId: ID,
  requestBody: { requests: [{ deleteDimension: {
    range: { sheetId, dimension: 'COLUMNS', startIndex: at, endIndex: at + 1 },
  } }] },
});

const after = ((await sheets.spreadsheets.values.get({
  spreadsheetId: ID, range: `'${SHEET}'!1:1`, valueRenderOption: 'UNFORMATTED_VALUE',
})).data.values ?? [[]])[0].map(c => String(c ?? '').trim());
console.log('');
console.log('消しました。');
console.log(`新しい見出し： ${after.join(' / ')}`);
