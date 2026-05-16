"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

import { Badge } from "../ui/badge";

const GithubMark = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <title>GitHub</title>
    <path d="M12 .297a12 12 0 0 0-3.794 23.385c.6.111.82-.26.82-.578v-2.234c-3.338.726-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.807 1.305 3.492.998.108-.776.42-1.305.762-1.605-2.665-.305-5.466-1.334-5.466-5.93 0-1.31.467-2.381 1.235-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23a11.5 11.5 0 0 1 6.003 0c2.291-1.552 3.297-1.23 3.297-1.23.654 1.652.243 2.873.12 3.176.77.84 1.233 1.911 1.233 3.221 0 4.609-2.807 5.621-5.479 5.92.43.371.823 1.102.825 2.222v3.293c0 .322.218.694.825.576A12 12 0 0 0 12 .297" />
  </svg>
);

const EASE = [0.16, 1, 0.3, 1] as const;

const navItems = [
  { href: "/", label: "Home" },
  { href: "/adapters", label: "Adapters" },
  { href: "/ai", label: "AI" },
  { href: "/cli", label: "CLI" },
  { href: "/api", label: "API" },
  { href: "/updates", label: "Updates" },
];

const isActiveHref = (href: string, pathname: string) =>
  href === "/" ? pathname === "/" : pathname.startsWith(href);

export const Header = () => {
  const pathname = usePathname();

  return (
    <header className="flex items-center justify-between gap-3">
      <nav aria-label="Primary" className="flex items-center gap-4 text-sm">
        {navItems.map(({ href, label }) => {
          const active = isActiveHref(href, pathname);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "transition-colors hover:text-foreground",
                active ? "text-foreground" : "text-muted-foreground"
              )}
              aria-current={active ? "page" : undefined}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <motion.a
        className="text-muted-foreground transition-colors hover:text-foreground"
        href="https://github.com/haydenbleasel/files-sdk"
        rel="noreferrer"
        target="_blank"
        aria-label="haydenbleasel/files-sdk on GitHub"
        initial={{ opacity: 0, x: 10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.5, ease: EASE }}
      >
        <span className="flex size-9 items-center justify-center rounded-full border border-dotted hover:bg-sidebar transition-colors sm:hidden">
          <GithubMark className="size-4" />
        </span>
        <Badge
          variant="outline"
          className="hidden sm:inline-flex h-auto py-2 px-4 bg-transparent hover:bg-sidebar transition-colors border-dotted"
        >
          <GithubMark className="size-3.5" />
          haydenbleasel/files-sdk
        </Badge>
      </motion.a>
    </header>
  );
};
