// The blocklist below is a guardrail against a fat-fingered paste, NOT a
// security boundary — it is a denylist over free-form shell text, so a
// determined caller always gets past it (`rm -rf / --no-preserve-root`
// already does: the pattern anchors on end-of-line). The real boundaries
// are operator auth, BRIDGE_LOCK_EXEC, and BRIDGE_ALLOWED_ROOTS. Add
// patterns for accidents worth catching; never rely on one to contain an
// attacker who already reached this endpoint.

export function execLocked(): boolean {
  return process.env.BRIDGE_LOCK_EXEC === "1";
}

export const BLOCKLIST: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(-[rRfF]+|--recursive|--force)\b.*\s(?:\/|~\/?)\s*$/m,
    reason: "rm -rf / blocked",
  },
  {
    pattern: /\brm\s+(-[rRfF]+|--recursive|--force)\b.*\s\*\s*$/m,
    reason: "rm -rf * blocked",
  },
  {
    pattern: /\bgit\s+push\s+.*--force(?:-with-lease)?\b.*\b(main|master|develop|production|trunk|release)\b/i,
    reason: "force-push to protected branch blocked",
  },
  {
    pattern: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*:/,
    reason: "fork-bomb pattern blocked",
  },
  {
    pattern: /\bcurl\s.+\|\s*(?:bash|sh|zsh|fish)\b/,
    reason: "curl | shell blocked",
  },
  {
    pattern: /\bwget\s.+\|\s*(?:bash|sh|zsh|fish)\b/,
    reason: "wget | shell blocked",
  },
  {
    pattern: /\b(?:sudo|doas)\s+/i,
    reason: "sudo/doas blocked in bridge shell",
  },
  {
    pattern: /\bsu\s+(?:-|\/s|\[)/i,
    reason: "su blocked in bridge shell",
  },
  {
    pattern: /\bdd\b[\s\\].*\bof=\/dev\/(?!(null|zero|random|urandom)\b)/i,
    reason: "dd to block device blocked",
  },
  {
    pattern: /\b(?:mkfs\.?\w*|mkswap|swapon|losetup)\b[\s\\].*\/dev\//i,
    reason: "mkfs/mkswap/losetup on /dev blocked",
  },
  {
    pattern: /\bdiskpart\b/i,
    reason: "diskpart blocked",
  },
  {
    pattern: /\bformat\s+[a-zA-Z]:\\/i,
    reason: "format drive blocked",
  },
  {
    pattern: /\bcipher\s+\/w\b/i,
    reason: "cipher /w blocked",
  },
  {
    pattern: /\/etc\/(?:shadow|sudoers|gshadow)\b/i,
    reason: "system credential paths blocked",
  },
  {
    pattern: /(?<![\w/])C:\\Windows\\System32\\Config\\(?:SAM|SYSTEM|SECURITY)\b/i,
    reason: "Windows SAM/SYSTEM hive paths blocked",
  },
  {
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i,
    reason: "shutdown/reboot blocked",
  },
];

export function checkBlocklist(command: string): { ok: true } | { ok: false; reason: string } {
  for (const { pattern, reason } of BLOCKLIST) {
    if (pattern.test(command)) return { ok: false, reason };
  }
  return { ok: true };
}

const PTY_INPUT_BUF_MAX = 8192;

export function filterPtyStdinChunk(
  state: { buf: string },
  chunk: string,
): { ok: true } | { ok: false; reason: string } {
  const next = (state.buf + chunk).slice(-PTY_INPUT_BUF_MAX);
  const r = checkBlocklist(next);
  if (!r.ok) {
    state.buf = "";
    return r;
  }
  state.buf = next;
  return { ok: true };
}
