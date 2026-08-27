
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const [, , modeArg, ...rest] = process.argv;
const mode = modeArg === "development" ? "development" : modeArg === "production" ? "production" : null;
if (!mode || rest.length === 0) {
  console.error(
    "usage: bun scripts/run.ts <development|production> <command> [...args]",
  );
  process.exit(1);
}

function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  const buf = readFileSync(file);
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.toString("utf16le").replace(/^﻿/, "");
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.toString("utf8").replace(/^﻿/, "");
  } else {
    text = buf.toString("utf8");
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadEnv(".env");
loadEnv(`.env.${mode}`);
loadEnv(".env.local");
loadEnv(`.env.${mode}.local`);
(process.env as Record<string, string>)["NODE_ENV"] = mode;

const [command, ...args] = rest;
const child = spawn(command, args, { stdio: "inherit", shell: true });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
