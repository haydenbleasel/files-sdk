import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";
import type { ReactNode } from "react";

import { MotionProvider } from "@/components/motion-provider";
import { Footer } from "@/components/sections/footer";
import { Header } from "@/components/sections/header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "localhost:3000";
const baseUrl = `${protocol}://${origin}`;

const title = "Files SDK - One API for S3, R2, GCS, Azure & blob storage";
const description =
  "A unified storage SDK for object and blob backends. One small, honest API. Web-standards I/O. An escape hatch when you need the native client.";

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
  },
  description,
  metadataBase: new URL(baseUrl),
  openGraph: {
    description,
    locale: "en_US",
    siteName: "Files SDK",
    title,
    type: "website",
    url: "/",
  },
  title: {
    default: title,
    template: "%s · Files SDK",
  },
  twitter: {
    card: "summary_large_image",
    description,
    title,
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  author: { "@type": "Person", name: "Hayden Bleasel" },
  codeRepository: "https://github.com/haydenbleasel/files-sdk",
  description,
  license: "https://opensource.org/licenses/MIT",
  name: "Files SDK",
  programmingLanguage: "TypeScript",
  url: baseUrl,
};

interface RootLayoutProps {
  children: ReactNode;
  toc: ReactNode;
}

const RootLayout = ({ children, toc }: RootLayoutProps) => (
  <html
    lang="en"
    data-scroll-behavior="smooth"
    className={cn(
      "scroll-smooth touch-manipulation font-sans antialiased",
      geistSans.variable,
      geistMono.variable
    )}
  >
    <body className="flex min-h-full flex-col">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is the standard pattern for structured data
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <TooltipProvider>
        <MotionProvider>
          <div className="relative isolate flex min-h-dvh flex-col bg-background">
            <div className="mx-auto w-full max-w-7xl flex-1 lg:grid lg:grid-cols-[1fr_42rem_1fr]">
              <div aria-hidden className="hidden lg:block" />
              <main className="mx-auto w-full max-w-2xl sm:border-x border-dotted px-4 sm:px-8 pt-8 pb-8 flex flex-col gap-12">
                <Header />
                <div className="flex flex-1 flex-col gap-12">{children}</div>
                <Footer />
              </main>
              <aside className="hidden lg:block pr-8 pt-44">
                <div className="sticky top-8">{toc}</div>
              </aside>
            </div>
          </div>
        </MotionProvider>
      </TooltipProvider>
    </body>
  </html>
);

export default RootLayout;
