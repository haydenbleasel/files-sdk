import { createFiles } from "files-sdk";
import { createFilesRouter } from "files-sdk/api";
import { memory } from "files-sdk/memory";
import { createRouteHandler } from "files-sdk/next";

// A single in-memory `Files` instance shared across requests for the duration of
// the dev server. A real app would point this at S3/R2/GCS/etc. and persist.
const files = createFiles({ adapter: memory() });

// The gateway exposes the whole Files API to the browser over this one endpoint.
// `authorize` is the per-operation gate: here it allows every verb but scopes
// every key under `demo/`, so the browser can never address outside that prefix.
// A production app would authenticate the request and return a per-user prefix
// (and throw to deny writes for read-only sessions).
const router = createFilesRouter({
  authorize: () => ({ keyPrefix: "demo/" }),
  files,
  secret: process.env.FILES_API_SECRET ?? "demo-secret-change-in-production",
});

// Sample content so the component docs render in a populated, "live" state. Keys
// sit under the `demo/` scope the gateway enforces, so the browser sees them as
// `photos/…`. Photos are real images pulled once from picsum.photos and stored
// in the in-memory adapter; the gateway then streams them to the components.
const swatch = (label: string, from: string, to: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><text x="50%" y="50%" fill="white" font-family="system-ui,sans-serif" font-size="34" font-weight="600" text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`;

interface SeedPhoto {
  key: string;
  seed: string;
  label: string;
  from: string;
  to: string;
}

const PHOTOS: SeedPhoto[] = [
  {
    from: "#fb923c",
    key: "demo/photos/sunset.jpg",
    label: "Sunset",
    seed: "files-sdk-sunset",
    to: "#db2777",
  },
  {
    from: "#34d399",
    key: "demo/photos/forest.jpg",
    label: "Forest",
    seed: "files-sdk-forest",
    to: "#0f766e",
  },
  {
    from: "#38bdf8",
    key: "demo/photos/ocean.jpg",
    label: "Ocean",
    seed: "files-sdk-ocean",
    to: "#4f46e5",
  },
  {
    from: "#a78bfa",
    key: "demo/photos/dusk.jpg",
    label: "Dusk",
    seed: "files-sdk-dusk",
    to: "#7c3aed",
  },
];

const seedPhoto = async (photo: SeedPhoto): Promise<void> => {
  try {
    const res = await fetch(`https://picsum.photos/seed/${photo.seed}/800/600`);
    if (!res.ok) {
      throw new Error(`picsum responded ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    await files.upload(photo.key, bytes, { contentType: "image/jpeg" });
  } catch {
    // Offline / picsum unreachable — fall back to a gradient swatch so the demo
    // still renders. Stored as SVG; the components key off the stored
    // content-type, not the file extension, so the `.jpg` key is harmless.
    await files.upload(photo.key, swatch(photo.label, photo.from, photo.to), {
      contentType: "image/svg+xml",
    });
  }
};

let seedPromise: Promise<unknown> | undefined;
const ensureSeeded = (): Promise<unknown> => {
  seedPromise ??= Promise.all([
    ...PHOTOS.map(seedPhoto),
    files.upload(
      "demo/photos/about.md",
      "# Welcome\n\nThis markdown file lives in the in-memory demo store that\nbacks the files-sdk component gallery.",
      { contentType: "text/markdown" }
    ),
  ]);
  return seedPromise;
};

const handlers = createRouteHandler(router);
const gate =
  (handler: (request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    await ensureSeeded();
    return handler(request);
  };

export const GET = gate(handlers.GET);
export const POST = gate(handlers.POST);
export const PUT = gate(handlers.PUT);
