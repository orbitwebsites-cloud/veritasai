import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "VeritasAI — every claim deserves a trial",
  description:
    "Adversarial fact-checking. Five models, five courtroom roles, live evidence " +
    "retrieval, and a citation audit against CrossRef.",
  openGraph: {
    title: "VeritasAI — every claim deserves a trial",
    description:
      "Put any claim before a five-model adversarial tribunal. Prosecution, " +
      "Defense, Expert Witness, and a Judge that rules.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0e1013",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
