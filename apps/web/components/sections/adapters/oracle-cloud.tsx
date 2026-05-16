import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const ORACLE_CLOUD_EXAMPLE = `import { Files } from "files-sdk";
import { oracleCloud } from "files-sdk/oracle-cloud";

const files = new Files({
  adapter: oracleCloud({
    bucket: "uploads",
    namespace: "axoki12345", // tenancy Object Storage namespace
    region: "us-ashburn-1",
    // accessKeyId / secretAccessKey auto-loaded from
    // OCI_ACCESS_KEY_ID / OCI_SECRET_ACCESS_KEY (Customer Secret Keys)
  }),
});`;

export const OracleCloud = () => (
  <section>
    <p>
      Oracle Cloud Infrastructure Object Storage via its S3 compatibility layer.
      A thin wrapper around the S3 adapter - endpoint derived from your tenancy
      namespace and region (
      <code>{`<namespace>.compat.objectstorage.<region>.oraclecloud.com`}</code>
      ), path-style addressing on (OCI's TLS cert doesn't cover bucket
      subdomains under the namespace prefix), errors relabelled. Auth uses OCI's
      HMAC <em>Customer Secret Keys</em>, not regular API signing keys -
      generate them under Profile → User Settings → Customer Secret Keys.
      Auto-loads from <code>OCI_ACCESS_KEY_ID</code> and{" "}
      <code>OCI_SECRET_ACCESS_KEY</code>.
    </p>
    <CodeBlock code={ORACLE_CLOUD_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>OCI bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="namespace" status="required" value="namespace">
          <p>
            Tenancy Object Storage namespace - a string assigned by Oracle when
            the tenancy is provisioned. Find it under Profile → Tenancy → Object
            Storage Namespace, or via <code>oci os ns get</code>. Drives the
            endpoint host's namespace prefix.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            OCI region identifier - <code>us-ashburn-1</code>,{" "}
            <code>us-phoenix-1</code>, <code>eu-frankfurt-1</code>,{" "}
            <code>uk-london-1</code>, <code>ap-tokyo-1</code>, etc. Drives the
            endpoint host and doubles as the SigV4 region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Customer Secret Key HMAC credentials - distinct from the API signing
            keys used by the official OCI CLI/SDK. Generate them under Profile →
            User Settings → Customer Secret Keys. Falls back to{" "}
            <code>OCI_ACCESS_KEY_ID</code> and{" "}
            <code>OCI_SECRET_ACCESS_KEY</code>; required if those env vars
            aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>
              {`https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`}
            </code>
            . Useful behind a custom proxy or for OC2 / OC3 realms with
            different host suffixes.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="forcePathStyle"
          status="optional"
          value="forcePathStyle"
        >
          <p>
            Use path-style addressing (<code>/&lt;bucket&gt;/&lt;key&gt;</code>)
            rather than virtual-hosted style. Defaults to <code>true</code> for
            OCI - the namespace-prefixed host already scopes lookups, and OCI's
            wildcard cert does not cover the additional bucket subdomain, so
            virtual-hosted style typically fails TLS.
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
            Useful for OCI Pre-Authenticated Requests or buckets fronted by an
            OCI Load Balancer / Web Application Firewall. When unset,{" "}
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
            <code>url()</code> when <code>publicBaseUrl</code> isn't set.
            Defaults to 3600 (1 hour). Per-call{" "}
            <code>url(key, {"{ expiresIn }"})</code> overrides.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
  </section>
);
