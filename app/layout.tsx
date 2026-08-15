import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Laboratorio Musical del Cautivo",
  description:
    "Herramientas locales para analizar, registrar y practicar Zampoña y Charango.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
