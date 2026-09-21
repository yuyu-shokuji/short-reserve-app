import { NextRequest, NextResponse } from 'next/server';

// 予約台帳アプリのログインパスワード。環境変数 RESERVE_PASSWORD があれば優先。
const PASSWORD = process.env.RESERVE_PASSWORD || 'yoyaku2024';

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  if (password !== PASSWORD) {
    return NextResponse.json({ error: 'wrong password' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set('rauth', 'ok', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
