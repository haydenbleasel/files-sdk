import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";

const ERROR_EXAMPLE = `import { FilesError } from "files-sdk";

try {
  await files.download("missing.png");
} catch (err) {
  if (err instanceof FilesError && err.code === "NotFound") {
    // handle gracefully
  }
  throw err;
}`;

export const Errors = () => (
  <section>
    <Heading as="h2">Errors</Heading>
    <p>
      All methods throw a single <code>FilesError</code> with a normalized{" "}
      <code>code</code>. The original provider error is attached as{" "}
      <code>cause</code>.
    </p>
    <CodeBlock code={ERROR_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="error-codes">
        Codes
      </Heading>
      <ul className="list-none! pl-0! gap-0! rounded-md border border-dotted divide-y divide-dotted">
        <li className="px-4 py-3">
          <code>"NotFound"</code> — key does not exist.
        </li>
        <li className="px-4 py-3">
          <code>"Unauthorized"</code> — credentials missing, expired, or
          insufficient.
        </li>
        <li className="px-4 py-3">
          <code>"Conflict"</code> — precondition failed, e.g. conditional write
          lost a race.
        </li>
        <li className="px-4 py-3">
          <code>"Provider"</code> — anything else; inspect <code>cause</code>{" "}
          for the underlying error.
        </li>
      </ul>
    </div>
  </section>
);
