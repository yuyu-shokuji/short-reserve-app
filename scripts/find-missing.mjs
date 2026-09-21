// 消えた予約を洗い出す（読み取りだけ・書き込みはしない）。
// ダミーは D01..Dnn の連番で入れてあるので、欠番＝消えた行。
// 中身は食事管理アプリの9月データから作り直せるので、そこから復元候補を出す。
//   node scripts/find-missing.mjs
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');
const ID = process.env.RESERVE_SPREADSHEET_ID || '1fjTPoqiDDHnGSfoYh9XqkEMK8JcmBThyxzbnO4CDtZE';
const MEAL_CONFIG_ID = '1zEgwHuqkBoiMKE5WWqGLZSEa7w9ItCw916ne645NvGY';
const Y = 2026, M = 9;

const SHORT_FIXED = 3, SHORT_N = 5, SHORT_DATA_R = 3, ROOM_ROWS = 20;
const nameCol = (d) => SHORT_FIXED + (d - 1) * SHORT_N;
const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });
const read = async (id, name) => (await sheets.spreadsheets.values.get({
  spreadsheetId: id, range: `'${name}'`, valueRenderOption: 'UNFORMATTED_VALUE' })).data.values ?? [];

// 現在の台帳
const rows = await read(ID, '予約');
const head = rows[0].map(c => String(c ?? '').trim());
const c = (k) => head.indexOf(k);
const now = rows.slice(1).filter(r => String(r[c('氏名')] ?? '').trim()).map(r => ({
  id: String(r[c('ID')] ?? '').trim(),
  name: String(r[c('氏名')] ?? '').trim(),
  building: String(r[c('棟')] ?? '').trim(),
  room: Number(r[c('部屋')]),
  start: String(r[c('開始日')] ?? '').trim(),
  end: String(r[c('終了日')] ?? '').trim(),
}));

// 9月の元データから、ダミー生成と同じ手順で「あるはずの予約」を作る
const reg = await read(MEAL_CONFIG_ID, '月レジストリ');
const hit = reg.slice(1).find(r => Number(r[0]) === Y && Number(r[1]) === M);
const rec = await read(String(hit[2]), 'ショート_記録');
const daysInMonth = new Date(Y, M, 0).getDate();

const expected = [];
let seq = 0;
for (let i = 0; i < ROOM_ROWS; i++) {
  const row = rec[SHORT_DATA_R + i] ?? [];
  const building = String(row[0] ?? '').trim();
  const roomNum = Number(row[1] ?? 0);
  if (!building || !roomNum) continue;
  let d = 1;
  while (d <= daysInMonth) {
    const who = String(row[nameCol(d)] ?? '').trim();
    if (!who) { d++; continue; }
    let end = d;
    while (end < daysInMonth && String(row[nameCol(end + 1)] ?? '').trim() === who) end++;
    expected.push({ id: `D${pad2(++seq)}`, name: who, building, room: roomNum,
      start: isoOf(Y, M, d), end: isoOf(Y, M, end) });
    d = end + 1;
  }
}

const haveIds = new Set(now.map(r => r.id));
const missing = expected.filter(e => !haveIds.has(e.id));
const extra = now.filter(r => !/^D\d+$/.test(r.id));

console.log(`台帳の行数: ${now.length}　／　ダミーとして作られたはずの件数: ${expected.length}`);
console.log('');
if (!missing.length) {
  console.log('・欠番はありません（ダミー分はすべて残っています）');
} else {
  console.log(`・欠番 ${missing.length}件 ＝ 消えた予約：`);
  for (const m of missing) {
    console.log(`   ${m.id}  ${m.name}  ${m.building}${pad2(m.room)}号  ${m.start} 〜 ${m.end}`);
  }
}
if (extra.length) {
  console.log('');
  console.log(`・あとから足された予約 ${extra.length}件（ダミーではないので触らない）：`);
  for (const e of extra) console.log(`   ${e.id}  ${e.name}  ${e.building}${pad2(e.room)}号  ${e.start} 〜 ${e.end}`);
}
