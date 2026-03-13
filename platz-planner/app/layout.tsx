import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Platz-Planner",
  description: "Training Allocator",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
