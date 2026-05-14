import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const S3_EXAMPLE = `import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

const files = new Files({
  adapter: s3({
    bucket: "uploads",
    region: "us-east-1",
    // credentials auto-loaded from the AWS chain
    // (env vars, IAM role, shared profile, ...)
  }),
});`;

export const S3 = () => (
  <section>
    <Heading as="h2" id="adapter-s3">
      S3
    </Heading>
    <p>
      AWS S3 (and any S3-compatible bucket). Uses the standard AWS credential
      chain - environment, IAM role, shared profile.
    </p>
    <CodeBlock code={S3_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-s3-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>S3 bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="optional" value="region">
          <p>
            AWS region the bucket lives in (e.g. <code>us-east-1</code>). Falls
            back to <code>AWS_REGION</code>; required if no env var is set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="credentials"
          status="optional"
          value="credentials"
        >
          <p>
            Static credentials -{" "}
            <code>{"{ accessKeyId, secretAccessKey, sessionToken? }"}</code>.
            Skip to use the AWS credential chain (env vars, IAM role, shared
            profile, EC2/ECS/EKS instance metadata).
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the S3 service endpoint. Use this to point at S3-compatible
            services (DigitalOcean Spaces, Wasabi, Backblaze B2, LocalStack,
            etc.).
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
            use this if your bucket is fronted by CloudFront or has a
            public-read policy. When unset, <code>url()</code> returns a
            presigned GetObject (1-hour default).
          </p>
        </PropAccordionItem>
      </Accordion>
    </div>
  </section>
);
