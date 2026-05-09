import { Heading } from "@/components/heading";

export const Why = () => (
  <section>
    <Heading as="h2">Why</Heading>
    <p>
      Object storage SDKs are all subtly different. <code>files-sdk</code>{" "}
      exposes the slice that's the same everywhere — upload, download, list,
      delete — behind a single class, and gets out of the way for anything
      provider-specific.
    </p>
    <ul>
      <li>
        <span className="text-foreground">One small API across providers.</span>{" "}
        Swap S3 for R2 for Vercel Blob for MinIO for DigitalOcean Spaces for
        Storj for Hetzner for Akamai for GCS for Azure Blob for Supabase for
        UploadThing without rewriting calls.
      </li>
      <li>
        <span className="text-foreground">Web-standards I/O.</span> Accepts{" "}
        <code>File</code>, <code>Blob</code>, <code>ReadableStream</code>,{" "}
        <code>ArrayBuffer</code>, <code>string</code>. Runs on Node, Bun,
        Workers, Vercel — anywhere fetch runs.
      </li>
      <li>
        <span className="text-foreground">
          Escape hatch via <code>files.raw</code>.
        </span>{" "}
        The native client is always one property away, typed per adapter —
        versioning, lifecycle, ACLs, multipart, all of it.
      </li>
      <li>
        <span className="text-foreground">Predictable errors.</span> A single{" "}
        <code>FilesError</code> with a normalized <code>code</code> across
        providers, and the original error attached as <code>cause</code>.
      </li>
    </ul>
  </section>
);
