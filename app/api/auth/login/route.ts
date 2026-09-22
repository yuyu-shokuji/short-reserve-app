import { NextRequest, NextResponse } from 'next/server';

/**
 * 予約台帳アプリのログインパスワード。
 *
 * 公開したものは環境変数 RESERVE_PASSWORD を必ず設定する。
 * ソースは GitHub に置くので、ここに書いた文字列は「公開されている」のと同じ。
 * そのため本番で未設定のときは、既定値で通してしまわずログイン自体を止める。
 * このPCでのお試し（next dev / next start）だけ、下の既定値で入れる。
 */
const LOCAL_DEFAULT = 'yoyaku2024';
const PASSWORD = process.env.RESERVE_PASSWORD || '';

export async function POST(req: NextRequest) {
  const isProd = process.env.NODE_ENV === 'production' && !!process.env.VERCEL;
  if (isProd && !PASSWORD) {
    return NextResponse.json(
      { error: 'パスワードが未設定です。Vercel の環境変数 RESERVE_PASSWORD を設定してください' },
      { status: 500 },
    );
  }

  const { password } = await req.json();
  if (password !== (PASSWORD || LOCAL_DEFAULT)) {
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
