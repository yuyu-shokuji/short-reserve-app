import { NextResponse } from 'next/server';
import { getMaster } from '@/lib/ledger';

export const dynamic = 'force-dynamic';

/** 部屋・利用者（画面の選択肢）。 */
export async function GET() {
  try {
    return NextResponse.json(await getMaster());
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
