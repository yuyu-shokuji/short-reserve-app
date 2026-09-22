import { NextRequest, NextResponse } from 'next/server';
import { buildBathSheet } from '@/lib/bath-sheet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';   // exceljs は Node の Buffer を使うので Edge では動かない

/** 入浴・洗濯管理表（1週間ぶん）を xlsx で返す。/api/bath-sheet?week=2026-09-20 */
export async function GET(req: NextRequest) {
  try {
    const week = req.nextUrl.searchParams.get('week') ?? '';
    const { buffer, filename, count } = await buildBathSheet(week);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        // 日本語のファイル名はそのままだと落ちるので RFC 5987 の形でも付ける
        'Content-Disposition':
          `attachment; filename="bath-sheet.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'X-Row-Count': String(count),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
