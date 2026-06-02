import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AV CAD-AI Sandbox",
  description: "AI-assisted CAD analysis testbed for bearing-wall opening detection",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
