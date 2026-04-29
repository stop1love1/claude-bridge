/**
 * One-time Telegram MTProto login flow.
 *
 *   bun scripts/telegram-login.ts
 *
 * Prompts for `apiId`, `apiHash`, phone number, the SMS/app code, and
 * (when enabled on the account) the 2FA password. On success:
 *
 *   1. Prints the resulting StringSession to stdout — you can copy it
 *      manually if the auto-save fails.
 *   2. Writes apiId / apiHash / session into
 *      `~/.claude/bridge.json.telegram.user` so the running bridge
 *      picks it up the next time `getTelegramUserClient()` is called.
 *
 * Re-running this script overwrites the existing session — use that to
 * rotate credentials or recover from a "session no longer authorized"
 * error after a Telegram security event.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import {
  getManifestTelegramSettings,
  setManifestTelegramSettings,
} from "../libs/apps";

const rl = createInterface({ input, output });

async function ask(prompt: string, opts: { mask?: boolean } = {}): Promise<string> {
  // We don't bother with true terminal-level masking — printing to
  // stdout would leak past `bun run` anyway. The `mask` flag here just
  // signals to the user that the input is sensitive; on TTY runs the
  // shell history is the operator's responsibility.
  const suffix = opts.mask ? " (input hidden — paste once and press Enter)" : "";
  const v = (await rl.question(`${prompt}${suffix}: `)).trim();
  return v;
}

async function main(): Promise<void> {
  const existing = getManifestTelegramSettings().user;
  if (existing.session) {
    console.log(
      "ℹ A Telegram user session is already saved in bridge.json. " +
      "Re-running this will overwrite it.",
    );
    const cont = (await ask("Continue? [y/N]")).toLowerCase();
    if (cont !== "y" && cont !== "yes") {
      console.log("Aborted.");
      rl.close();
      return;
    }
  }

  console.log("\nTelegram MTProto credentials live at https://my.telegram.org/apps");
  console.log("(If you don't have an app registered, create one — any name works.)");

  const apiIdRaw =
    (await ask(`apiId${existing.apiId ? ` [${existing.apiId}]` : ""}`)) ||
    String(existing.apiId || "");
  const apiId = Number(apiIdRaw);
  if (!Number.isFinite(apiId) || apiId <= 0) {
    console.error("✗ apiId must be a positive integer.");
    rl.close();
    process.exit(1);
  }

  const apiHashRaw =
    (await ask(`apiHash${existing.apiHash ? ` [${existing.apiHash.slice(0, 4)}…]` : ""}`)) ||
    existing.apiHash;
  if (!apiHashRaw) {
    console.error("✗ apiHash required.");
    rl.close();
    process.exit(1);
  }

  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHashRaw, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => ask("phone number (E.164, e.g. +84912345678)"),
    phoneCode: async () => ask("login code (sent to your Telegram app)"),
    password: async () => ask("2FA password (blank if none)", { mask: true }),
    onError: (err) => {
      console.error("✗ login error:", err.message);
    },
  });

  const sessionString = session.save();
  console.log("\n✓ Logged in. StringSession (paste this if auto-save fails):");
  console.log("");
  console.log(sessionString);
  console.log("");

  const targetChatId =
    (await ask(`targetChatId for outbound notifications (blank = "Saved Messages")`)) ||
    existing.targetChatId;

  setManifestTelegramSettings({
    user: {
      apiId,
      apiHash: apiHashRaw,
      session: sessionString,
      targetChatId,
    },
  });
  console.log(
    "✓ Saved to ~/.claude/bridge.json. The bridge will pick up the new session on next request.",
  );

  // Quick sanity check: send a hello to confirm the channel works.
  try {
    await client.sendMessage(targetChatId || "me", {
      message: "✅ Claude Bridge user-client login OK",
    });
    console.log("✓ Test message sent.");
  } catch (err) {
    console.warn("⚠ Test send failed:", (err as Error).message);
  }

  await client.disconnect();
  rl.close();
}

main().catch((err) => {
  console.error("✗", (err as Error).message);
  process.exit(1);
});
