import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";

const RAW_EXAMPLE = `// Typed per adapter - S3Client, R2Bucket, VercelBlobClient, ...
const s3 = files.raw;

await s3.send(
  new PutObjectAclCommand({ Bucket: "uploads", Key: "a.png", ACL: "public-read" }),
);`;

export const EscapeHatch = () => (
  <section>
    <Heading as="h2">Escape hatch</Heading>
    <p>
      When you need a feature outside the unified surface - S3 versioning,
      lifecycle rules, ACLs, multipart, anything - drop down to the native
      client. The <code>raw</code> property is typed per adapter, so you keep
      autocomplete.
    </p>
    <CodeBlock code={RAW_EXAMPLE} lang="ts" />
  </section>
);
