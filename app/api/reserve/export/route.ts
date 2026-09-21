import { NextRequest, NextResponse } from 'next/server';
import { exportReservationsToMonth, type ExportMode } from '@/lib/reserve';

export const dynamic = 'force-dynamic';

/**
 * 指定月の「確定」予約を ショート_記録 へ書き出す。
 * mode 未指定で先客がいる日があれば、何も書かずに { conflict: true } を返す。
 */
export async function POST(req: NextRequest) {
  try {
    const p = await req.json();
    const year = Number(p.year), month = Number(p.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: '年月が不正です' }, { status: 400 });
    }
    const mode: ExportMode | undefined =
      p.mode === 'skip' || p.mode === 'overwrite' ? p.mode : undefined;
    const result = await exportReservationsToMonth(year, month, {
      mode,
      ids: Array.isArray(p.ids) ? p.ids.map(String) : undefined,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
