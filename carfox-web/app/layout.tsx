import type { Metadata } from "next";
import "./globals.css";
import FoxWidget from "@/components/FoxWidget";

export const metadata: Metadata = {
  title: "Car Fox — Every car has a story.",
  description:
    "A curated performance lot with a live, conversational Car Fox. Ask about any car — out loud, right on the page.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <FoxWidget />
      </body>
    </html>
  );
}
