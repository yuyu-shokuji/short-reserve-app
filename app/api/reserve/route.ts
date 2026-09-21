import { NextRequest, NextResponse } from 'next/server';
import {
  listReservationsForMonth, saveReservation, deleteReservation, findReserveConflicts,
} from '@/lib/reserve';
import { listSheetMonths } from '@/lib/sheets';

export const dynamic = 'force-dynamic';

/** 指定月にかかる予約と、その月のシートが作成済みかどうか（＝書き出せるか）を返す。 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const year = Number(sp.get('year'));
    const month = Number(sp.get('month'));
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: '年月が不正です' }, { status: 400 });
    }
    const [reservations, months] = await Promise.all([
      listReservationsForMonth(year, month),
      listSheetMonths(),
    ]);
    return NextResponse.json({
      year, month,
      daysInMonth: new Date(year, month, 0).getDate(),
      reservations,
      monthRegistered: months.some(m => m.year === year && m.month === month),
      months: months.map(m => ({ year: m.year, month: m.month })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** 予約の追加・更新。force でない場合は重なりを検出して知らせる（書き込まない）。 */
export async function POST(req: NextRequest) {
  try {
    const p = await req.json();
    if (!p.force) {
      const conflicts = await findReserveConflicts({
        id: p.id, name: String(p.name ?? ''), building: String(p.building ?? ''),
        room: Number(p.room), start: String(p.start ?? ''), end: String(p.end ?? ''),
      });
      if (conflicts.length) return NextResponse.json({ conflict: true, conflicts });
    }
    const id = await saveReservation({
      id: p.id, name: p.name, building: p.building, room: Number(p.room),
      start: p.start, end: p.end, status: p.status === '確定' ? '確定' : '仮予約', note: p.note,
    });
    return NextResponse.json({ ok: true, id });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: 'id がありません' }, { status: 400 });
    const removed = await deleteReservation(String(id));
    return NextResponse.json({ ok: true, removed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
