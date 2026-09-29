import { NextRequest, NextResponse } from 'next/server';
import { buildRecordSheet, FormKey } from '@/lib/record-sheet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';   // exceljs は Node の Buffer を使うので Edge では動かない

/** 記録表（1日ぶん）を xlsx で返す。/api/record-sheet?day=2026-10-09&form=1 */
export async function GET(req: NextRequest) {
  try {
    const day = req.nextUrl.searchParams.get('day') ?? '';
    const form = (req.nextUrl.searchParams.get('form') ?? '1') as FormKey;
    if (form !== '1' && form !== '2') throw new Error('form は 1 か 2 です');
    const { buffer, filename, filled } = await buildRecordSheet(day, form);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':
          `attachment; filename="record.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'X-Filled-Count': String(filled),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
