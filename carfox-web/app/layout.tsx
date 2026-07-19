import type { Metadata, Viewport } from "next";
import "./globals.css";
import FoxWidget from "@/components/FoxWidget";

export const metadata: Metadata = {
  title: "Car Fox — Every car has a story.",
  description:
    "A curated performance lot with a live, conversational Car Fox. Ask about any car — out loud, right on the page.",
  // Private preview — keep the site out of search indexes entirely.
  robots: { index: false, follow: false, nocache: true },
};

// viewport-fit=cover lets the fox dock/panel respect iOS safe-area insets
// (notch + home indicator) via env(safe-area-inset-*).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
