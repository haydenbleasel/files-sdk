import { CodeBlock } from "@/components/code-block";
import { CodeTabs } from "@/components/code-tabs";
import { Heading } from "@/components/heading";

const INSTALL_TABS = [
  { code: "npm install -g files-sdk", id: "npm", label: "npm", lang: "bash" },
  { code: "pnpm add -g files-sdk", id: "pnpm", label: "pnpm", lang: "bash" },
  { code: "bun add -g files-sdk", id: "bun", label: "bun", lang: "bash" },
  {
    code: "yarn global add files-sdk",
    id: "yarn",
    label: "yarn",
    lang: "bash",
  },
] as const;

const NPX_TABS = [
  {
    code: "npx -p files-sdk files --provider fs --root ./uploads list",
    id: "npx",
    label: "npx",
    lang: "bash",
  },
  {
    code: "pnpm dlx -p files-sdk files --provider fs --root ./uploads list",
    id: "pnpm",
    label: "pnpm dlx",
    lang: "bash",
  },
  {
    code: "bunx --package files-sdk files --provider fs --root ./uploads list",
    id: "bun",
    label: "bunx",
    lang: "bash",
  },
  {
    code: "yarn dlx -p files-sdk files --provider fs --root ./uploads list",
    id: "yarn",
    label: "yarn dlx",
    lang: "bash",
  },
] as const;

const PROVIDERS = [
  "s3",
  "r2",
  "gcs",
  "azure",
  "vercel-blob",
  "netlify-blobs",
  "supabase",
  "minio",
  "digitalocean-spaces",
  "backblaze-b2",
  "wasabi",
  "scaleway",
  "ovhcloud",
  "hetzner",
  "tigris",
  "storj",
  "filebase",
  "akamai",
  "idrive-e2",
  "vultr",
  "ibm-cos",
  "oracle-cloud",
  "exoscale",
  "uploadthing",
  "dropbox",
  "box",
  "google-drive",
  "onedrive",
  "sharepoint",
  "appwrite",
  "cloudinary",
  "fs",
];

const COMMAND_EXAMPLES = `# Upload from a file (or pipe stdin)
files --provider s3 --bucket uploads \\
  upload reports/2026-q1.pdf --file ./report.pdf --content-type application/pdf

cat report.pdf | files --provider s3 --bucket uploads \\
  upload reports/2026-q1.pdf --stdin --content-type application/pdf

# Download to disk or stream to stdout
files --provider s3 --bucket uploads download reports/2026-q1.pdf --out ./report.pdf
files --provider s3 --bucket uploads download reports/2026-q1.pdf --stdout > report.pdf

# Metadata, existence, listing
files --provider s3 --bucket uploads head reports/2026-q1.pdf
files --provider s3 --bucket uploads exists reports/2026-q1.pdf   # exit 0 = exists, 1 = missing
files --provider s3 --bucket uploads list --prefix reports/ --limit 50

# Server-side copy + delete
files --provider s3 --bucket uploads copy reports/2026-q1.pdf reports/archive/q1.pdf
files --provider s3 --bucket uploads delete reports/archive/q1.pdf

# URLs (presigned on signing adapters, public for CDN-backed providers)
files --provider s3 --bucket uploads url reports/2026-q1.pdf --expires-in 600

# Browser uploads via presigned POST policy (enforces size server-side)
files --provider s3 --bucket uploads sign-upload uploads/avatar.png \\
  --expires-in 600 --max-size 5242880 --content-type image/png`;

const OUTPUT_EXAMPLE = `# JSON output is the default — pipe straight to jq.
$ files --provider fs --root /tmp/store head reports/q1.pdf
{"key":"reports/q1.pdf","name":"q1.pdf","size":48213,"type":"application/pdf","lastModified":1778881504647,"etag":"\\"9feb94ca37e5d155\\""}

# Errors go to stderr with a stable error code. Exit codes:
#   0  ok
#   1  NotFound (or exists → false)
#   2  Provider / unknown error
#   3  Unauthorized
#   4  Conflict
$ files --provider fs --root /tmp/store head nope.txt
{"error":{"code":"NotFound","message":"ENOENT: no such file or directory, stat '/tmp/store/nope.txt'"}}
$ echo $?
1`;

const STREAMING_EXAMPLE = `# Stream binary in/out without temp files
ffmpeg -i talk.mov -c copy -f mp4 - \\
  | files --provider r2 --bucket talks upload 2026/q1/keynote.mp4 --stdin --content-type video/mp4

files --provider r2 --bucket talks download 2026/q1/keynote.mp4 --stdout \\
  | ffprobe -i - 2>&1

# Plan before doing — useful as a sanity check inside an agent loop
files --provider s3 --bucket uploads --dry-run delete reports/q1.pdf
# → {"dryRun":true,"provider":"s3","action":"delete","key":"reports/q1.pdf"}

# Verbose adds stack traces to error output
files --provider s3 --bucket uploads --verbose head missing.txt`;

const MCP_RUN = `# Start the MCP server on stdio
files --provider s3 --bucket uploads mcp`;

const MCP_CONFIG = `// Wire it into Claude Code (~/.claude.json or .claude/mcp.json)
{
  "mcpServers": {
    "files-sdk": {
      "command": "files",
      "args": ["--provider", "s3", "--bucket", "uploads", "mcp"],
      "env": {
        "AWS_ACCESS_KEY_ID": "...",
        "AWS_SECRET_ACCESS_KEY": "..."
      }
    }
  }
}`;

const AGENT_EXAMPLE = `# 1. Quick exploration — let an agent inspect a bucket without writing code
files --provider s3 --bucket uploads list --prefix invoices/ --limit 20 | jq '.items[].key'

# 2. Programmatic loop — feed JSON straight to the next step
cursor=""
while :; do
  page=$(files --provider s3 --bucket uploads list --prefix logs/ --limit 100 \\
    \${cursor:+--cursor "$cursor"})
  echo "$page" | jq -r '.items[].key' | while read key; do
    files --provider s3 --bucket uploads download "$key" --stdout | gunzip | grep ERROR
  done
  cursor=$(echo "$page" | jq -r '.cursor // empty')
  [ -z "$cursor" ] && break
done

# 3. Provider override via env — agents don't need to thread --provider everywhere
export FILES_SDK_PROVIDER=fs
files --root ./sandbox list`;

export const Cli = () => (
  <section className="flex flex-col gap-8">
    <section>
      <Heading as="h2" id="cli-install">
        Install
      </Heading>
      <p>
        The CLI ships with the <code>files-sdk</code> package — install it
        globally to get a <code>files</code> binary on your <code>PATH</code>,
        or invoke it via <code>npx</code> / <code>bunx</code> for one-off
        commands.
      </p>
      <CodeTabs tabs={INSTALL_TABS} />
      <p>One-shot, no install:</p>
      <CodeTabs tabs={NPX_TABS} />
      <p>
        Adapter SDKs (AWS, GCP, Azure, Dropbox, etc.) are loaded lazily on first
        use, so cold-start cost matches whichever single provider you select —
        not the union of all of them.
      </p>
    </section>

    <section>
      <Heading as="h2" id="cli-providers">
        Pick a provider
      </Heading>
      <p>
        Pass <code>--provider &lt;name&gt;</code> on every call, or set{" "}
        <code>FILES_SDK_PROVIDER</code> once. Provider-specific credentials come
        from the adapter's standard env vars (<code>AWS_ACCESS_KEY_ID</code>,{" "}
        <code>BLOB_READ_WRITE_TOKEN</code>,{" "}
        <code>GOOGLE_APPLICATION_CREDENTIALS</code>, etc.), so the same
        environment that works with the SDK works with the CLI.
      </p>
      <div className="rounded-lg border border-dotted p-4 text-sm flex flex-wrap gap-x-3 gap-y-1.5 font-mono text-muted-foreground">
        {PROVIDERS.map((p) => (
          <span key={p}>{p}</span>
        ))}
      </div>
      <p>
        Common short flags cover the obvious fields (<code>--bucket</code>,{" "}
        <code>--region</code>, <code>--endpoint</code>, <code>--root</code>,{" "}
        <code>--container</code>, <code>--token</code>, etc.). For the long
        tail, <code>--config-json &apos;{"{...}"}&apos;</code> accepts the raw
        adapter options blob — anything the SDK factory accepts, the CLI can
        pass through.
      </p>
    </section>

    <section>
      <Heading as="h2" id="cli-commands">
        Commands
      </Heading>
      <p>
        Each command maps 1:1 to an <code>Adapter</code> method. Same semantics,
        same <code>FilesError</code> codes, same <code>StoredFile</code> shape
        on the way out.
      </p>
      <CodeBlock code={COMMAND_EXAMPLES} lang="bash" />
    </section>

    <section>
      <Heading as="h2" id="cli-output">
        JSON output &amp; exit codes
      </Heading>
      <p>
        Every command emits one JSON line on success. Errors go to{" "}
        <code>stderr</code> with a stable{" "}
        <code>{"{ error: { code, message } }"}</code> envelope, never mixed with
        the success channel — so a JSON parser downstream sees either a clean
        record or nothing.
      </p>
      <CodeBlock code={OUTPUT_EXAMPLE} lang="bash" />
      <p>
        Use <code>--pretty</code> for indented JSON when reading manually, or{" "}
        <code>--no-json</code> for plain-text output (still suitable for{" "}
        <code>grep</code>, just not for parsing).
      </p>
    </section>

    <section>
      <Heading as="h2" id="cli-streaming">
        Streaming &amp; dry-run
      </Heading>
      <p>
        <code>upload --stdin</code> reads the body from <code>stdin</code>;{" "}
        <code>download --stdout</code> writes it to <code>stdout</code>. No
        intermediate file, no extra copy. Metadata for stdout downloads is
        suppressed by default and only emitted to <code>stderr</code> when{" "}
        <code>--verbose</code> is set, so the byte stream stays clean.
      </p>
      <p>
        <code>--dry-run</code> resolves the provider and prints the operation it{" "}
        <em>would</em> run, without making a network call. Handy as a sanity
        check inside an agent loop before letting it execute writes.
      </p>
      <CodeBlock code={STREAMING_EXAMPLE} lang="bash" />
    </section>

    <section>
      <Heading as="h2" id="cli-mcp">
        MCP server
      </Heading>
      <p>
        <code>files ... mcp</code> boots an{" "}
        <a
          className="underline decoration-dotted underline-offset-4 hover:text-foreground"
          href="https://modelcontextprotocol.io"
          rel="noreferrer"
          target="_blank"
        >
          MCP server
        </a>{" "}
        on stdio that exposes every CLI command as a tool — <code>upload</code>,{" "}
        <code>download</code>, <code>head</code>, <code>exists</code>,{" "}
        <code>delete</code>, <code>copy</code>, <code>list</code>,{" "}
        <code>url</code>, <code>sign-upload</code>. The provider and credentials
        are bound at server startup; the agent only passes operation arguments,
        never secrets.
      </p>
      <CodeBlock code={MCP_RUN} lang="bash" />
      <CodeBlock code={MCP_CONFIG} lang="jsonc" />
      <p>
        Binary payloads are roundtripped as base64 over MCP, so binary downloads
        (<code>download</code>) and uploads (<code>upload</code> with a{" "}
        <code>base64</code> body) survive intact.
      </p>
    </section>

    <section>
      <Heading as="h2" id="cli-agents">
        Wiring agents
      </Heading>
      <p>
        Three patterns, ordered by how much trust you're extending to the agent.
      </p>
      <CodeBlock code={AGENT_EXAMPLE} lang="bash" />
      <p>
        For read-only investigation, the JSON output piped through{" "}
        <code>jq</code> is usually enough. For multi-step workflows, the MCP
        server keeps tool calls structured and avoids quoting bugs in shell
        composition. For everything in between, the plain CLI with{" "}
        <code>--dry-run</code> gates is the path of least surprise.
      </p>
    </section>
  </section>
);
