/**
 * One-time bridge auth setup.
 *
 *   bun scripts/set-password.ts
 *
 * Prompts for an email + password, hashes the password with scrypt,
 * and writes the result to `~/.claude/bridge.json#auth`. Also generates
 * a fresh HMAC signing secret and an internal-bypass token if the
 * install doesn't have them yet — both are stable across re-runs so
 * existing browser sessions keep working when you rotate the password.
 *
 * Re-running this script:
 *   - replaces the password (every existing browser cookie still
 *     verifies because the HMAC secret is preserved — log out from
 *     "Trusted devices" if you want to force a re-login everywhere).
 *   - lets you change the email; only one operator account exists.
 *
 * Pass `--rotate-secret` to also re-roll the HMAC + internal tokens
 * (use after a suspected leak; this invalidates every active session).
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes } from "node:crypto";
import {
  MIN_PASSWORD_LENGTH,
  loadAuthConfig,
  saveAuthConfig,
  setOperatorCredentials,
} from "../libs/auth";

const rl = createInterface({ input, output });
const ROTATE = process.argv.includes("--rotate-secret");

async function ask(prompt: string): Promise<string> {
  return (await rl.question(`${prompt}: `)).trim();
}

async function askPassword(prompt: string): Promise<string> {
  // Best-effort masking: zero-width replacement on each keystroke so
  // the password isn't echoed. Falls back to plain readline if the
  // stdin isn't a TTY (CI / piped input).
  if (!input.isTTY) {
    return await rl.question(`${prompt}: `);
  }
  return new Promise<string>((resolve) => {
    output.write(`${prompt}: `);
    let buf = "";
    const onData = (chunk: Buffer) => {
      const c = chunk.toString("utf8");
      // Ctrl-C
      if (c === "") { output.write("\n"); process.exit(130); }
      // Enter
      if (c === "\r" || c === "\n") {
        input.setRawMode(false);
        input.removeListener("data", onData);
        input.pause();
        output.write("\n");
        resolve(buf);
        return;
      }
      // Backspace
      if (c === "" || c === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          output.write("\b \b");
        }
        return;
      }
      buf += c;
      output.write("*");
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function main() {
  const existing = loadAuthConfig();

  console.log(existing
    ? `Updating credentials for existing operator "${existing.email}".`
    : "First-time bridge auth setup.");

  const emailPrompt = existing
    ? `Email [${existing.email}]`
    : "Email";
  const emailRaw = await ask(emailPrompt);
  const email = (emailRaw || existing?.email || "").trim();
  if (!email) {
    console.error("Email is required.");
    process.exit(1);
  }

  const password = await askPassword(`Password (min ${MIN_PASSWORD_LENGTH} chars)`);
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }
  const confirm = await askPassword("Confirm password");
  if (confirm !== password) {
    console.error("Passwords don't match.");
    process.exit(1);
  }

  const next = await setOperatorCredentials(email, password);

  if (ROTATE) {
    const rotated = {
      ...next,
      secret: b64url(randomBytes(32)),
      internalToken: b64url(randomBytes(32)),
      // Drop every trusted device — they can't be verified after the
      // secret rotates anyway, but explicit > implicit.
      trustedDevices: [],
    };
    saveAuthConfig(rotated);
    console.log("Rotated HMAC secret + internal token. All active sessions are invalidated.");
  }

  console.log(`Credentials saved for "${next.email}".`);
  console.log("Restart the bridge (`bun dev`) to pick up the new auth state if it was already running.");
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
