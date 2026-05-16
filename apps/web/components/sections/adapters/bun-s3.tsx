import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const BUN_S3_EXAMPLE = `import { Files } from "files-sdk";
import { bunS3 } from "files-sdk/bun-s3";

const files = new Files({
  adapter: bunS3({
    bucket: "uploads",
    region: "us-east-1",
    // accessKeyId / secretAccessKey auto-loaded by Bun from
    // S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (or AWS_* equivalents)
  }),
});

// Or hand it the singleton Bun.s3 client directly:
new Files({ adapter: bunS3({ client: Bun.s3 }) });`;

export const BunS3 = () => (
  <section>
    <Heading as="h2" id="adapter-bun-s3">
      Bun S3
    </Heading>
    <p>
      AWS S3 (and any S3-compatible bucket) via Bun&apos;s native{" "}
      <code>Bun.S3Client</code> instead of <code>@aws-sdk/client-s3</code>.
      Bun-only: skip the AWS SDK and use the runtime&apos;s built-in primitive
      when you&apos;re already on Bun. The adapter is a thin wrapper around{" "}
      <code>Bun.S3Client</code>&apos;s <code>file()</code>, <code>write()</code>
      , <code>stat()</code>, <code>list()</code>, and <code>presign()</code>.
    </p>
    <p>
      Three things differ from <code>files-sdk/s3</code>: <code>copy()</code>{" "}
      streams bytes through your process because Bun doesn&apos;t expose a
      server-side <code>CopyObject</code> primitive; <code>upload()</code>{" "}
      throws on <code>metadata</code> and <code>cacheControl</code> because{" "}
      <code>Bun.S3Client.write()</code> has no equivalent options; and{" "}
      <code>signedUploadUrl()</code> throws on <code>maxSize</code> because Bun
      exposes presigned URLs only - not S3 POST policy fields. Reach for{" "}
      <code>files-sdk/s3</code> on the same bucket when you need any of those.
    </p>
    <CodeBlock code={BUN_S3_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-bun-s3-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="client" status="optional" value="client">
          <p>
            A pre-configured <code>Bun.S3Client</code>-shaped instance - for
            example the global <code>Bun.s3</code>, or one constructed with
            specific credentials elsewhere in your app. When set, the adapter
            uses it as-is and rejects any of <code>bucket</code>,{" "}
            <code>region</code>, <code>endpoint</code>,{" "}
            <code>virtualHostedStyle</code>, <code>accessKeyId</code>,{" "}
            <code>secretAccessKey</code>, <code>sessionToken</code> at
            construction (they would be silently ignored otherwise). When unset,
            the adapter constructs its own client from the options below.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="bucket" status="optional" value="bucket">
          <p>
            S3 bucket name. Scopes operations and is exposed as{" "}
            <code>adapter.bucket</code>. Falls back to <code>S3_BUCKET</code> /{" "}
            <code>AWS_BUCKET</code> via Bun&apos;s built-in resolution.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="optional" value="region">
          <p>
            AWS region (e.g. <code>us-east-1</code>). Falls back to{" "}
            <code>S3_REGION</code> / <code>AWS_REGION</code> via Bun&apos;s
            resolution.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey / sessionToken"
          status="optional"
          value="credentials"
        >
          <p>
            Static credentials. Skip to let Bun resolve them from{" "}
            <code>S3_ACCESS_KEY_ID</code> / <code>AWS_ACCESS_KEY_ID</code>,{" "}
            <code>S3_SECRET_ACCESS_KEY</code> /{" "}
            <code>AWS_SECRET_ACCESS_KEY</code>, and{" "}
            <code>S3_SESSION_TOKEN</code> / <code>AWS_SESSION_TOKEN</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the S3 service endpoint. Use this to point at S3-compatible
            services (R2, DigitalOcean Spaces, Wasabi, MinIO, …).
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="virtualHostedStyle"
          status="optional"
          value="virtualHostedStyle"
        >
          <p>
            Use virtual-hosted-style addressing (
            <code>https://&lt;bucket&gt;.&lt;endpoint&gt;</code>) instead of
            path-style. Defaults to <code>false</code> - flip on for endpoints
            that require it.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="publicBaseUrl"
          status="optional"
          value="publicBaseUrl"
        >
          <p>
            Origin used to build URLs from <code>url()</code>. When set,{" "}
            <code>url(key)</code> returns{" "}
            <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing -
            use this if your bucket is fronted by a CDN or has a public-read
            policy. Passing <code>responseContentDisposition</code> still forces
            a signed URL even when this is set, because a permanent CDN URL has
            no signature in which to bind the override. When unset,{" "}
            <code>url()</code> returns a presigned GetObject (1-hour default).
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="defaultUrlExpiresIn"
          status="optional"
          value="defaultUrlExpiresIn"
        >
          <p>
            Default expiry, in seconds, for the presigned URLs returned by{" "}
            <code>url()</code> when <code>publicBaseUrl</code> isn&apos;t set.
            Defaults to 3600 (1 hour). Per-call{" "}
            <code>url(key, {"{ expiresIn }"})</code> overrides.
          </p>
        </PropAccordionItem>
      </Accordion>
    </div>
  </section>
);
