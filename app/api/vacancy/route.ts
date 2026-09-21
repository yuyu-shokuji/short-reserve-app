import { NextRequest, NextResponse } from 'next/server';
import { findVacancies } from '@/lib/ledger';

export const dynamic = 'force-dynamic';

/**
 * 指定期間を丸ごと押さえられる部屋はどれか。
 * 問い合わせの電話中に「その期間空いてますか」へすぐ答えるための問い合わせ。
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const start = String(sp.get('start') ?? '');
    const end = String(sp.get('end') ?? '');
    const excludeId = sp.get('excludeId') ?? undefined;
    return NextResponse.json(await findVacancies(start, end, excludeId || undefined));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
