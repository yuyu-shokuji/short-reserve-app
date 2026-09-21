import { NextRequest, NextResponse } from 'next/server';
import { getMonthOverview } from '@/lib/short-sheet';

export const dynamic = 'force-dynamic';

/** 書き出した結果の確認用。その月の ショート_記録 を読むだけ（書き込みなし）。 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const year = Number(sp.get('year'));
    const month = Number(sp.get('month'));
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: '年月が不正です' }, { status: 400 });
    }
    return NextResponse.json(await getMonthOverview(year, month));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
