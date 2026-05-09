import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  description:
    "A unified storage SDK for object/blob backends — S3, Cloudflare R2, Vercel Blob, MinIO, Google Cloud Storage, Azure Blob Storage.",
  title: "files-sdk",
};

interface RootLayoutProps {
  children: ReactNode;
}

const RootLayout = ({ children }: RootLayoutProps) => (
  <html
    lang="en"
    className={cn(
      "touch-manipulation font-sans antialiased",
      geistSans.variable,
      geistMono.variable
    )}
  >
    <body className="flex min-h-full flex-col">{children}</body>
  </html>
);

export default RootLayout;
