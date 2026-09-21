// 予約台帳 専用スプレッドシートを作り、9月のショートデータをダミーとして流し込む。
//
// このアプリは食事管理アプリとは別のスプレッドシートを持つ（まずは単体で作るため）。
// 食事管理側からは「読むだけ」で、ダミーを作る最初の1回しか触らない。
//
//   node scripts/setup-spreadsheet.mjs             … 新規作成＋ダミー投入（IDを表示）
//   node scripts/setup-spreadsheet.mjs --id=<ID>   … 用意ずみのスプレッドシートへ投入
//
// ⚠ サービスアカウントにはDrive容量が無いので、新規作成は403になることが多い。
//   そのときは人がGoogleドライブで空のスプレッドシートを作り、
//   meal-bot@yuyu-meal.iam.gserviceaccount.com に編集者権限を共有してから --id= で渡す。
//
// 実行後、表示されたIDを lib/sheets.ts の RESERVE_SPREADSHEET_ID に入れる。

import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, '..', '..', 'sheets-migration', 'service-account-key.json');

// 食事管理側の設定スプレッドシート（月レジストリの置き場）。ここからは読むだけ。
const MEAL_CONFIG_ID = '1zEgwHuqkBoiMKE5WWqGLZSEa7w9ItCw916ne645NvGY';
const DUMMY_YEAR = 2026, DUMMY_MONTH = 9;
const SHARE_EMAIL = process.env.SHARE_EMAIL ?? 'yuyu.shokuji@gmail.com';

// ショート_記録 の構造（食事管理アプリと同じ）
const SHORT_FIXED = 3, SHORT_N = 5, SHORT_DATA_R = 3, ROOM_ROWS = 20;
const nameCol = (d) => SHORT_FIXED + (d - 1) * SHORT_N;

const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

const auth = new google.auth.GoogleAuth({
  keyFile: KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

const SHEETS = {
  reserve: '予約',
  people: '利用者',
  rooms: '部屋',
};

// 予約シートの見出し。列は必ず見出し名で探すので、順番を変えても壊れない。
const RESERVE_HEADER = ['ID', '氏名', '棟', '部屋', '開始日', '終了日', '状態', '送迎', '迎え時間', '送り時間', '備考', '登録日時'];
const PEOPLE_HEADER  = ['氏名', 'ふりがな', '連絡先', '備考'];
const ROOMS_HEADER   = ['棟', '部屋', '使用しない', '仮置き', '備考'];

async function readAoa(spreadsheetId, name) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${name}'`, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return res.data.values ?? [];
}

async function writeAoa(spreadsheetId, name, aoa) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${name}'` });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${name}'!A1`, valueInputOption: 'RAW',
    requestBody: { values: aoa.map(r => r.map(c => (c ?? ''))) },
  });
}

/** 食事管理側の設定スプレッドシートから、間違って作った「ショート予約」シートを消す。 */
async function removeStrayLedgerSheet() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: MEAL_CONFIG_ID, fields: 'sheets.properties' });
  const stray = (meta.data.sheets ?? []).find(s => s.properties?.title === 'ショート予約');
  if (!stray) { console.log('・食事管理側に「ショート予約」シートはありません（掃除ずみ）'); return; }

  const rows = await readAoa(MEAL_CONFIG_ID, 'ショート予約');
  const dataRows = rows.slice(1).filter(r => r.some(c => String(c ?? '').trim()));
  if (dataRows.length) {
    throw new Error(`中止: 食事管理側の「ショート予約」に ${dataRows.length}行 のデータが残っています。中身を確認してください`);
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: MEAL_CONFIG_ID,
    requestBody: { requests: [{ deleteSheet: { sheetId: stray.properties.sheetId } }] },
  });
  console.log('・食事管理側の「ショート予約」シート（空）を削除しました');
}

/**
 * 専用スプレッドシートを新規作成する。
 * ※ サービスアカウントにはDrive容量が無いため、たいてい403になる。
 *    その場合は人がGoogleドライブで空のスプレッドシートを作り、meal-bot に編集権限を共有して
 *    --id=<ID> で渡す（下の prepareSheets 以降は同じ処理）。
 */
async function createSpreadsheet() {
  const created = await drive.files.create({
    requestBody: { name: 'ショート予約台帳', mimeType: 'application/vnd.google-apps.spreadsheet' },
    fields: 'id',
  });
  const id = created.data.id;
  try {
    await drive.permissions.create({
      fileId: id,
      requestBody: { role: 'writer', type: 'user', emailAddress: SHARE_EMAIL },
      sendNotificationEmail: false,
    });
    console.log(`・${SHARE_EMAIL} に編集権限を共有しました`);
  } catch (e) {
    console.log(`・共有に失敗（書き込みは可能）: ${e.message}`);
  }
  return id;
}

/** 予約／利用者／部屋 の3シートを用意する（足りないものだけ作る）。 */
async function prepareSheets(id) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties' });
  const existing = meta.data.sheets.map(s => s.properties);
  const names = Object.values(SHEETS);
  const missing = names.filter(n => !existing.some(p => p.title === n));
  if (!missing.length) return;

  const requests = [];
  // 新品のスプレッドシートは「シート1」だけ。それを1枚目にリネームして使う（空シートを残さない）。
  const spare = existing.find(p => !names.includes(p.title) && existing.length === 1);
  if (spare) {
    requests.push({ updateSheetProperties: { properties: { sheetId: spare.sheetId, title: missing[0] }, fields: 'title' } });
    missing.shift();
  }
  for (const title of missing) requests.push({ addSheet: { properties: { title } } });
  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests } });
  console.log(`・シートを用意しました: ${names.join(' / ')}`);
}

/** 9月のショートデータを読んで、連続滞在を1予約＝1行に畳む。 */
async function buildDummy() {
  const reg = await readAoa(MEAL_CONFIG_ID, '月レジストリ');
  const hit = reg.slice(1).find(r => Number(r[0]) === DUMMY_YEAR && Number(r[1]) === DUMMY_MONTH);
  if (!hit) throw new Error(`${DUMMY_YEAR}年${DUMMY_MONTH}月が月レジストリにありません`);
  const srcId = String(hit[2]);

  const rec = await readAoa(srcId, 'ショート_記録');
  const nam = await readAoa(srcId, 'ショート_名');
  const daysInMonth = new Date(DUMMY_YEAR, DUMMY_MONTH, 0).getDate();

  // 利用者（氏名・ふりがな）。非表示の人も台帳では候補に残す（過去の予約が出せるように）。
  const people = nam.slice(1)
    .map((r, i) => ({ name: String(r[0] ?? '').trim(), furi: String(r[1] ?? '').trim(), i }))
    .filter(p => p.name)
    .sort((a, b) => {
      if (!a.furi && b.furi) return 1;
      if (a.furi && !b.furi) return -1;
      return a.furi.localeCompare(b.furi, 'ja') || a.i - b.i;
    })
    .map(p => [p.name, p.furi, '', '']);

  // 部屋（最後に入れ替え用の仮置きを1つ足す。空き部屋数には数えない）
  const rooms = [];
  for (let i = 0; i < ROOM_ROWS; i++) {
    const row = rec[SHORT_DATA_R + i] ?? [];
    const b = String(row[0] ?? '').trim();
    const n = Number(row[1] ?? 0);
    if (b && n) rooms.push([b, n, '', '', '']);
  }
  rooms.push(['仮置き', 1, '', 'あり', '入れ替え用の一時置き場（空き部屋数には数えません）']);

  // 予約：部屋ごとに氏名列の連続した同じ名前を1件に畳む
  const reserves = [];
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
      reserves.push([
        `D${pad2(++seq)}`, who, building, roomNum,
        isoOf(DUMMY_YEAR, DUMMY_MONTH, d), isoOf(DUMMY_YEAR, DUMMY_MONTH, end),
        '確定', '', '', '', '', '',
      ]);
      d = end + 1;
    }
  }
  return { people, rooms, reserves };
}

// ── 実行 ──────────────────────────────────────────────────────────────
const argId = process.argv.find(a => a.startsWith('--id='))?.slice(5);
const reseed = process.argv.includes('--reseed');

if (!reseed) await removeStrayLedgerSheet();

const id = argId ?? (reseed ? null : await createSpreadsheet());
if (!id) throw new Error('--reseed には --id=<スプレッドシートID> が必要です');
if (!argId) console.log(`・専用スプレッドシートを作成しました: ${id}`);

await prepareSheets(id);

const { people, rooms, reserves } = await buildDummy();
await writeAoa(id, SHEETS.reserve, [RESERVE_HEADER, ...reserves]);
await writeAoa(id, SHEETS.people,  [PEOPLE_HEADER,  ...people]);
await writeAoa(id, SHEETS.rooms,   [ROOMS_HEADER,   ...rooms]);

console.log(`・ダミー投入: 予約 ${reserves.length}件 / 利用者 ${people.length}名 / 部屋 ${rooms.length}室`);
console.log('');
console.log('次にやること: lib/sheets.ts の RESERVE_SPREADSHEET_ID を次の値にする');
console.log(`  ${id}`);
console.log(`  https://docs.google.com/spreadsheets/d/${id}/edit`);
