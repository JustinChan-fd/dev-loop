// The --overnight filter: reads `claude -p --output-format stream-json` on
// stdin, appends every raw line to the file named in argv[2] (the full
// record), and prints one readable line per event (formatStreamLine). It
// runs on the host inside the screen session; see scripts/claude-sbx.mjs.
//
// It sits in the run's pipe, so it must never die first: a dead reader would
// break the pipe and stop the run. Every step is guarded, and it reads to EOF.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { formatStreamLine } from "../src/sandbox/sbx/session.ts";

process.on("uncaughtException", () => {});
process.stdout.on("error", () => {}); // tee gone (screen killed): keep draining stdin
process.on("SIGINT", () => {}); // Ctrl-c in the screen goes to claude, not here

const raw = process.argv[2];
const time = () => new Date().toTimeString().slice(0, 8);
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (raw) { try { appendFileSync(raw, `${line}\n`); } catch { /* keep going */ } }
  try {
    for (const out of formatStreamLine(line, time())) process.stdout.write(`${out}\n`);
  } catch { /* keep going */ }
}
