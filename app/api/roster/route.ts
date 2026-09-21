import { NextResponse } from 'next/server';
import { getShortOccupants } from '@/lib/short-sheet';

export const dynamic = 'force-dynamic';

/** 氏名の候補（ショート_名の非表示を除く・ふりがな順）。読み取りのみ。 */
export async function GET() {
  try {
    return NextResponse.json({ occupants: await getShortOccupants() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
