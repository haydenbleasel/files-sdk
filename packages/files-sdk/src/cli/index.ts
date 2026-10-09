#!/usr/bin/env node
import { fail } from "./io.js";
import { buildProgram } from "./program.js";

// Downstream consumers (head, less, piping into another process) close their
// end of the pipe before we finish writing. The default Node behavior is to
// throw EPIPE and exit nonzero with a stack trace — unfriendly for what is
// normal UNIX usage. Treat closed-downstream as success. Any other stdout
// error (EIO, EBADF, a full disk behind a redirect) is a real failure:
// registering this handler suppresses the default throw, so it must report
// and exit non-zero itself rather than silently "succeed" having written
// nothing.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    process.exit(0);
  }
  process.stderr.write(`error: stdout write failed: ${err.message}\n`);
  process.exit(2);
});

// Always run on import — this module is wired up as the package's `bin`
// entry, not consumed as a library. Tests/inspectors that need the program
// itself import `./program.js` directly.
//
// The program's exit override calls `process.exit` directly on parse errors
// (unknown flags, missing required args — exit 2), so this catch only fires
// for errors raised from inside an action handler — and even those are
// usually intercepted by the per-command `wrap()` so they print the JSON
// error envelope. This is a last-ditch net for anything that escapes both.
try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  fail(error, { json: true, pretty: false, verbose: false });
}
