#!/usr/bin/env node
import { fail } from "./io.js";
import { buildProgram } from "./program.js";

// Downstream consumers (head, less, piping into another process) close their
// end of the pipe before we finish writing. The default Node behavior is to
// throw EPIPE and exit nonzero with a stack trace — unfriendly for what is
// normal UNIX usage. Treat closed-downstream as success.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    process.exit(0);
  }
});

// Always run on import — this module is wired up as the package's `bin`
// entry, not consumed as a library. Tests/inspectors that need the program
// itself import `./program.js` directly.
//
// commander's default exit override calls `process.exit` directly on parse
// errors (unknown flags, missing required args), so this catch only fires
// for errors raised from inside an action handler — and even those are
// usually intercepted by the per-command `wrap()` so they print the JSON
// error envelope. This is a last-ditch net for anything that escapes both.
try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  fail(error, { json: true, pretty: false, verbose: false });
}
