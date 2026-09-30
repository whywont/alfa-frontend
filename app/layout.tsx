import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alfa — protein structure prediction",
  description: "Paste sequences, come back to ranked, interpretable structures.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <a href="/" className="brand">Alfa</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
