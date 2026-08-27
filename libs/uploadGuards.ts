
import { resolve, sep } from "node:path";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".msp",
  ".dll", ".sys", ".lnk", ".url",
  ".appx", ".appxbundle", ".msu", ".msix", ".msixbundle",
  ".reg",
  ".ps1", ".psm1", ".psd1",
  ".vbs", ".vbe", ".wsf", ".wsh", ".hta", ".chm",
  ".js", ".jse",
  ".jar", ".class",
  ".sh", ".bash", ".zsh", ".ksh", ".fish",
  ".py", ".pyw", ".pyc", ".pyo",
  ".rb", ".pl", ".pm", ".php", ".phar",
  ".mjs", ".cjs", ".lua",
  ".iso", ".img", ".vhd", ".vhdx",
  ".html", ".htm", ".xhtml", ".shtml", ".svg", ".svgz", ".mhtml",
]);

const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export type UploadGuardResult =
  | { ok: true; sanitized: string }
  | { ok: false; reason: UploadGuardReason; detail?: string };

export type UploadGuardReason =
  | "empty-name"
  | "blocked-extension"
  | "reserved-name"
  | "outside-upload-dir";

export function sanitizeUploadName(raw: string): string {
  if (typeof raw !== "string") return "";
  let cleaned = raw.replace(/[\\/:*?"<>|]/g, "_");
  cleaned = cleaned.replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned;
}

export function extractExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx).toLowerCase();
}

function extractStem(name: string): string {
  const idx = name.indexOf(".");
  return (idx === -1 ? name : name.slice(0, idx)).toLowerCase();
}

export function hasBlockedExtension(name: string): boolean {
  const ext = extractExtension(name);
  return ext.length > 0 && BLOCKED_EXTENSIONS.has(ext);
}

export function isReservedDeviceName(name: string): boolean {
  return RESERVED_DEVICE_NAMES.has(extractStem(name));
}

export function validateUploadName(raw: string): UploadGuardResult {
  const sanitized = sanitizeUploadName(raw);
  if (sanitized.length === 0) return { ok: false, reason: "empty-name" };
  if (isReservedDeviceName(sanitized)) {
    return { ok: false, reason: "reserved-name", detail: sanitized };
  }
  if (hasBlockedExtension(sanitized)) {
    return {
      ok: false,
      reason: "blocked-extension",
      detail: extractExtension(sanitized),
    };
  }
  return { ok: true, sanitized };
}

export function assertInsideUploadDir(
  uploadDir: string,
  candidatePath: string,
): boolean {
  const resolvedDir = resolve(uploadDir);
  const resolvedCandidate = resolve(candidatePath);
  return (
    resolvedCandidate === resolvedDir ||
    resolvedCandidate.startsWith(resolvedDir + sep)
  );
}
