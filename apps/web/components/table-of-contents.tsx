"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

interface Section {
  id: string;
  label: string;
  children?: { id: string; label: string }[];
}

const sections: Section[] = [
  { id: "why", label: "Why" },
  { id: "installation", label: "Installation" },
  { id: "quick-start", label: "Quick start" },
  {
    children: [
      { id: "adapter-s3", label: "S3" },
      { id: "adapter-r2", label: "Cloudflare R2" },
      { id: "adapter-vercel-blob", label: "Vercel Blob" },
      { id: "adapter-netlify-blobs", label: "Netlify Blobs" },
      { id: "adapter-minio", label: "MinIO" },
      { id: "adapter-digitalocean-spaces", label: "DigitalOcean Spaces" },
      { id: "adapter-storj", label: "Storj" },
      { id: "adapter-hetzner", label: "Hetzner" },
      { id: "adapter-akamai", label: "Akamai Object Storage" },
      { id: "adapter-gcs", label: "Google Cloud Storage" },
      { id: "adapter-google-drive", label: "Google Drive" },
      { id: "adapter-onedrive", label: "OneDrive" },
      { id: "adapter-dropbox", label: "Dropbox" },
      { id: "adapter-azure", label: "Azure Blob Storage" },
      { id: "adapter-supabase", label: "Supabase Storage" },
      { id: "adapter-uploadthing", label: "UploadThing" },
      { id: "adapter-fs", label: "Filesystem" },
    ],
    id: "adapters",
    label: "Adapters",
  },
  {
    children: [
      { id: "files-upload", label: "upload" },
      { id: "files-download", label: "download" },
      { id: "files-head", label: "head" },
      { id: "files-delete", label: "delete" },
      { id: "files-copy", label: "copy" },
      { id: "files-list", label: "list" },
      { id: "files-url", label: "url" },
      { id: "files-signed-upload-url", label: "signedUploadUrl" },
    ],
    id: "api-reference",
    label: "API reference",
  },
  { id: "the-storedfile-type", label: "The StoredFile type" },
  { id: "errors", label: "Errors" },
  { id: "escape-hatch", label: "Escape hatch" },
  { id: "compatibility-matrix", label: "Compatibility matrix" },
];

export const TableOfContents = () => {
  const [activeId, setActiveId] = useState<string>(sections[0].id);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .toSorted(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
          );
        if (visible[0]) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0 }
    );

    const ids = sections.flatMap(({ id, children }) => [
      id,
      ...(children?.map((child) => child.id) ?? []),
    ]);

    for (const id of ids) {
      const el = document.querySelector(`#${id}`);
      if (el) {
        observer.observe(el);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, []);

  const activeParentId = sections.find(
    ({ id, children }) =>
      id === activeId || children?.some((child) => child.id === activeId)
  )?.id;

  return (
    <nav aria-label="On this page">
      <ul className="flex list-none flex-col gap-0 pl-0">
        {sections.map(({ id, label, children }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={cn(
                "block -ml-px border-l py-1 pl-4 text-xs leading-relaxed transition-colors",
                activeId === id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </a>
            {children && activeParentId === id ? (
              <ul className="flex list-none flex-col gap-0 pl-0">
                {children.map((child) => (
                  <li key={child.id}>
                    <a
                      href={`#${child.id}`}
                      className={cn(
                        "block -ml-px border-l py-1 pl-8 text-xs leading-relaxed transition-colors",
                        activeId === child.id
                          ? "border-foreground text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {child.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
};
