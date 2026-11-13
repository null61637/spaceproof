import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SpaceProof — integridad verificable de archivos satelitales",
  description:
    "Certificá un archivo satelital y sus metadatos, anclá su huella en Avalanche y verificá después que no cambió.",
};

/** The mark: an orbit and the point it certifies. Same drawing as app/icon.svg. */
function Mark() {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
    >
      <ellipse
        cx="16"
        cy="16"
        rx="13"
        ry="6.5"
        transform="rotate(-28 16 16)"
        strokeWidth="1.6"
        opacity="0.55"
      />
      <circle cx="16" cy="16" r="4.2" fill="currentColor" stroke="none" />
      <circle cx="26.6" cy="9.4" r="1.9" fill="var(--accent)" stroke="none" />
    </svg>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <header className="border-b border-line/70">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
            <Link
              href="/"
              className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight"
            >
              <Mark />
              SpaceProof
            </Link>
            <span className="eyebrow hidden sm:block">Avalanche Fuji · testnet</span>
          </div>
        </header>
        {children}
        <footer className="border-t border-line/70">
          <p className="hint mx-auto max-w-5xl px-4 py-5 sm:px-6">
            SpaceProof prueba que un archivo y sus metadatos no cambiaron desde
            que se certificaron. No prueba su procedencia, su autoría ni que
            los metadatos declarados sean verdaderos. No conserva los archivos.
          </p>
        </footer>
      </body>
    </html>
  );
}
