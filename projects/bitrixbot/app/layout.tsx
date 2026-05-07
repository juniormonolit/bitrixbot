import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bitrixbot",
  description: "Контроль пропущенных звонков"
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}

