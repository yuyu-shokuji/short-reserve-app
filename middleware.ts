import { NextRequest, NextResponse } from 'next/server';

// 認証不要のパス（ログイン画面とログインAPI）
const PUBLIC_PATHS = ['/login', '/api/auth/login'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // 入力(auth)・厨房(kauth)・経理(aauth)とは別のクッキー＝相互にログインは共有しない
  const auth = req.cookies.get('rauth')?.value;
  if (auth === 'ok') {
    return NextResponse.next();
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = '/login';
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.ico).*)'],
};
