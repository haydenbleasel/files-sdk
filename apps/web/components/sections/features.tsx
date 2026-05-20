import { AlertTriangle, Layers, Wrench, Zap } from "lucide-react";

const FEATURES = [
  {
    description:
      "Upload, download, list, delete — the same eight calls across every provider. Swap your storage backend without rewriting call sites.",
    icon: Layers,
    title: "One small API",
  },
  {
    description:
      "Accepts File, Blob, ReadableStream, ArrayBuffer, string. Runs on Node, Bun, Workers, Vercel — anywhere fetch runs.",
    icon: Zap,
    title: "Web-standards I/O",
  },
  {
    description:
      "The native client is always one property away via files.raw, typed per adapter — versioning, lifecycle, ACLs, multipart, all of it.",
    icon: Wrench,
    title: "Typed escape hatch",
  },
  {
    description:
      "A single FilesError with a normalized code across providers, and the original error attached as cause. Catch once, branch on intent.",
    icon: AlertTriangle,
    title: "Predictable errors",
  },
];

export const Features = () => (
  <section>
    <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
      <div>
        <p className="font-mono text-xs text-muted-foreground">What you get</p>
        <h2 className="mt-3 max-w-[30ch] text-4xl font-medium tracking-tight text-balance text-foreground sm:text-5xl">
          The slice that's the same everywhere.
        </h2>
        <p className="mt-5 max-w-[60ch] text-lg leading-relaxed text-pretty text-muted-foreground">
          Object storage SDKs are all subtly different. files-sdk exposes the
          common slice behind a single class, and gets out of the way for
          anything provider-specific.
        </p>
      </div>
      <dl className="mt-16 grid grid-cols-1 gap-x-12 gap-y-12 sm:grid-cols-2">
        {FEATURES.map(({ description, icon: Icon, title }) => (
          <div className="flex flex-col gap-3" key={title}>
            <dt className="flex items-center gap-2.5 text-base font-medium text-foreground">
              <Icon className="size-4 text-muted-foreground" />
              {title}
            </dt>
            <dd className="text-base leading-relaxed text-pretty text-muted-foreground">
              {description}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  </section>
);
