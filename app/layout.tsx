import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Axis — variable font editor",
  description:
    "Upload a font or a whole family — TTF, OTF, WOFF, WOFF2, TTC — combine drawn and synthesised masters, add tabular figures, and export a variable font.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
