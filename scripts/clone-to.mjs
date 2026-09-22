// いまの予約台帳スプレッドシートの中身を、別のスプレッドシートへ丸ごと写す。
//
// 使いどころ：本番用とは別に「練習用」のファイルを持ちたいとき。
// 現場に触ってもらうのは練習用にしておけば、何をどう操作されても本番のデータは傷つかない。
//
// ⚠️ サービスアカウントは Drive の容量を持っていないので**ファイルを新規作成できない**。
//    先に人がドライブで空のスプレッドシートを作り（または既存をコピーし）、
//    meal-bot@yuyu-meal.iam.gserviceaccount.com に「編集者」で共有しておくこと。
//
//   node scripts/clone-to.mjs --to=<コピー先のID>            … 何が起きるか見るだけ
//   node scripts/clone-to.mjs --to=<コピー先のID> --apply    … 実際に写す
//
// コピー先の同名シートは中身を消してから書き直す（実行するたび、写した時点の姿になる）。
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');
const FROM = process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';
const arg = (n) => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? '').split('=')[1] ?? '';
const TO = arg('to');
const apply = process.argv.includes('--apply');
const SHEETS = ['予約', '利用者', '部屋', '削除ログ'];

if (!TO) {
  console.log('コピー先のIDを --to=<ID> で指定してください');
  console.log('（スプレッドシートのURLの /d/ と /edit のあいだの文字列）');
  process.exit(1);
}
if (TO === FROM) { console.log('コピー元とコピー先が同じです'); process.exit(1); }

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

// ── コピー先に触れるか先に確かめる（共有し忘れがいちばん多い） ──
let dstMeta;
try {
  dstMeta = await sheets.spreadsheets.get({ spreadsheetId: TO, fields: 'properties.title,sheets.properties.title' });
} catch (e) {
  console.log('コピー先を開けませんでした：' + e.message);
  console.log('→ そのスプレッドシートを meal-bot@yuyu-meal.iam.gserviceaccount.com に「編集者」で共有してください');
  process.exit(1);
}
const srcMeta = await sheets.spreadsheets.get({ spreadsheetId: FROM, fields: 'properties.title' });
const dstTitles = (dstMeta.data.sheets ?? []).map(s => s.properties?.title ?? '');

console.log(`コピー元： ${srcMeta.data.properties.title}`);
console.log(`コピー先： ${dstMeta.data.properties.title}`);
console.log('');

// ── 読み出し ───────────────────────────────────────────────
const got = await sheets.spreadsheets.values.batchGet({
  spreadsheetId: FROM, ranges: SHEETS.map(n => `'${n}'`), valueRenderOption: 'UNFORMATTED_VALUE',
});
const data = {};
(got.data.valueRanges ?? []).forEach((vr, i) => { data[SHEETS[i]] = vr.values ?? []; });
for (const n of SHEETS) console.log(`   ${n}： ${Math.max(0, (data[n] ?? []).length - 1)}行`);
console.log('');

const missing = SHEETS.filter(n => !dstTitles.includes(n));
if (missing.length) console.log(`コピー先に無いシートを作ります： ${missing.join(' / ')}`);

if (!apply) {
  console.log('');
  console.log('※ 確認のみ。実際に写すには --apply を付けてください');
  console.log('※ コピー先の同名シートは中身を消してから書き直します');
  process.exit(0);
}

// ── 足りないシートを作る ──────────────────────────────────
if (missing.length) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: TO,
    requestBody: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) },
  });
}

// ── 消してから書く（古い行が下に残らないように） ──────────
await sheets.spreadsheets.values.batchClear({
  spreadsheetId: TO, requestBody: { ranges: SHEETS.map(n => `'${n}'`) },
});
// 1回のまとめ書き込み。シートごとにAPIを呼ぶとクォータに当たるうえ遅い。
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: TO,
  requestBody: {
    valueInputOption: 'RAW',
    data: SHEETS.filter(n => (data[n] ?? []).length).map(n => ({
      range: `'${n}'!A1`,
      values: data[n].map(r => r.map(c => (c ?? ''))),
    })),
  },
});

console.log('写しました。');
console.log('');
console.log('公開版にこちらを見せるには、Vercel の環境変数に入れてください：');
console.log(`   RESERVE_SPREADSHEET_ID = ${TO}`);
