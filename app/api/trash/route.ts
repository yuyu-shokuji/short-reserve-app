import { NextResponse } from 'next/server';
import { listTrash } from '@/lib/ledger';

export const dynamic = 'force-dynamic';

/** 消した予約の履歴（新しい順）。あとから気づいたときに拾い直すため。 */
export async function GET() {
  try {
    return NextResponse.json({ entries: await listTrash(50) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
