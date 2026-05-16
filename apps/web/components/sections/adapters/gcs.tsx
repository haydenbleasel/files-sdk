import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const GCS_EXAMPLE = `import { Files } from "files-sdk";
import { gcs } from "files-sdk/gcs";

const files = new Files({
  adapter: gcs({
    bucket: "uploads",
    // No credentials needed in most setups - the @google-cloud/storage
    // SDK auto-discovers Application Default Credentials from
    // GOOGLE_APPLICATION_CREDENTIALS, gcloud auth, or the runtime
    // service account on Cloud Run / GKE / GCE.
  }),
});`;

export const Gcs = () => (
  <section>
    <p>
      Google Cloud Storage via the official <code>@google-cloud/storage</code>{" "}
      SDK. Auth follows the standard Google chain - Application Default
      Credentials by default, with explicit overrides if you need them.
    </p>
    <CodeBlock code={GCS_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>GCS bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="projectId" status="optional" value="projectId">
          <p>
            GCP project ID. Falls back to <code>GOOGLE_CLOUD_PROJECT</code> then{" "}
            <code>GCLOUD_PROJECT</code>. Application Default Credentials carry a
            project ID, so this is rarely needed.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="keyFilename"
          status="optional"
          value="keyFilename"
        >
          <p>
            Path to a service-account JSON file. Takes precedence over ADC when
            set. Use this when ADC isn't available - typically outside GCP
            runtimes.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="credentials"
          status="optional"
          value="credentials"
        >
          <p>
            Inline service-account credentials -{" "}
            <code>{"{ client_email, private_key }"}</code>. Useful when you only
            have those fields as separate env vars (Vercel, Netlify) and don't
            want to materialize a JSON file. <code>url()</code> and{" "}
            <code>signedUploadUrl()</code> need either inline credentials or the{" "}
            <code>iam.serviceAccounts.signBlob</code> permission on the runtime
            service account so the SDK can fall back to IAM SignBlob.
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
            <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
            For a public GCS bucket the natural value is{" "}
            <code>https://storage.googleapis.com/&lt;bucket&gt;</code>; or point
            at a Cloud CDN / load balancer host. When unset, <code>url()</code>{" "}
            returns a V4 signed read URL (1-hour default; GCS caps V4 at 7
            days).
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
  </section>
);
