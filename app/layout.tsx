import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ショート予約台帳 - グラン悠遊",
  description: "グラン悠遊 ショートステイの予約台帳",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
