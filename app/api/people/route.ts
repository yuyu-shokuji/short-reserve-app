import { NextRequest, NextResponse } from 'next/server';
import { addPerson } from '@/lib/ledger';

export const dynamic = 'force-dynamic';

/**
 * 利用者を1人足す（「利用者」タブから）。一覧の読み込みは /api/master。
 * ⚠️ 試験運用のあいだだけの入口。食事管理アプリと統合するときに、ダブった人は消す。
 */
export async function POST(req: NextRequest) {
  try {
    const p = await req.json();
    const person = await addPerson({
      name: String(p.name ?? ''), furi: String(p.furi ?? ''),
      contact: String(p.contact ?? ''), note: String(p.note ?? ''),
    });
    return NextResponse.json({ person });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
