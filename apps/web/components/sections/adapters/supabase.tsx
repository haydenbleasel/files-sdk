import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const SUPABASE_EXAMPLE = `import { Files } from "files-sdk";
import { supabase } from "files-sdk/supabase";

const files = new Files({
  adapter: supabase({
    bucket: "uploads",
    // Auto-loads url + key from SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
    // and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_KEY /
    // NEXT_PUBLIC_SUPABASE_ANON_KEY. Or pass an existing SupabaseClient
    // via \`client\` to share with auth/postgrest.
  }),
});`;

export const Supabase = () => (
  <section>
    <p>
      Supabase Storage via the official <code>@supabase/storage-js</code> SDK.
      Auto-loads the project URL and an API key from the standard env vars; pass{" "}
      <code>client</code> to share an existing <code>SupabaseClient</code> with
      the rest of your app (auth, postgrest).
    </p>
    <CodeBlock code={SUPABASE_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>
            Supabase storage bucket. Must already exist - this SDK does not
            create buckets.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="client" status="optional" value="client">
          <p>
            Existing client to share with the rest of your app (auth,
            postgrest). Highest-precedence credential. Pass either a{" "}
            <code>StorageClient</code> from <code>@supabase/storage-js</code> or
            a <code>SupabaseClient</code> from{" "}
            <code>@supabase/supabase-js</code> - the adapter unwraps{" "}
            <code>client.storage</code> automatically.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="url" status="required" value="url">
          <p>
            Supabase project URL, e.g. <code>https://xxxx.supabase.co</code>.
            The adapter appends <code>/storage/v1</code> automatically. Falls
            back to <code>SUPABASE_URL</code> then{" "}
            <code>NEXT_PUBLIC_SUPABASE_URL</code>. Required unless{" "}
            <code>client</code> is passed.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="key" status="required" value="key">
          <p>
            Supabase API key. The service role key is required for writes on
            RLS-protected buckets; the anon key works for public buckets. Falls
            back to <code>SUPABASE_SERVICE_ROLE_KEY</code>,{" "}
            <code>SUPABASE_KEY</code>, then{" "}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>. Required unless{" "}
            <code>client</code> is passed.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="public" status="optional" value="public">
          <p>
            Treat the bucket as public. When <code>true</code>,{" "}
            <code>url()</code> returns the permanent unsigned{" "}
            <code>getPublicUrl()</code> result instead of minting a signed read
            URL. Supabase has no API to detect bucket visibility, so the adapter
            trusts what you pass - a wrong value yields a 4xx on fetch.
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
            <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips both
            signing and <code>getPublicUrl()</code>. Use for a CDN in front of
            the project. Implies <code>public: true</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="defaultUrlExpiresIn"
          status="optional"
          value="defaultUrlExpiresIn"
        >
          <p>
            Default expiry, in seconds, for the signed read URLs returned by{" "}
            <code>url()</code> when neither <code>public</code> nor{" "}
            <code>publicBaseUrl</code> is set. Defaults to 3600 (1 hour).
            Per-call <code>url(key, {"{ expiresIn }"})</code> overrides.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
    <section>
      <Heading as="h2" id="limitations">
        Limitations
      </Heading>
      <p>
        <code>signedUploadUrl()</code> issues PUT-only. <code>maxSize</code>{" "}
        throws - Supabase signed upload URLs have no{" "}
        <code>content-length-range</code> equivalent; set the bucket-level file
        size limit in the Supabase dashboard or enforce caps at your application
        gateway. <code>expiresIn</code> on <code>signedUploadUrl()</code> is
        ignored - Supabase fixes the TTL at 2 hours server-side.{" "}
        <code>list()</code> uses Supabase's V1 offset/limit API; the adapter
        encodes <code>offset</code> as a numeric cursor string so it threads
        through the unified API.
      </p>
    </section>
  </section>
);
