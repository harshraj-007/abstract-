import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Abstract — A little context changes everything",
  description:
    "Open a GitHub repository, explore its source, and start understanding how it fits together.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
