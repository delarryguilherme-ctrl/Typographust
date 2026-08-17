import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Axis — variable font editor",
  description:
    "Upload a static TTF, synthesise weights, italics and custom axes, preview live, and export a variable font.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
