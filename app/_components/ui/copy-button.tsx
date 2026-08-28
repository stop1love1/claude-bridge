"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/libs/cn";

/**
 * Copies `text` and flips to a check for a moment. Falls back to a hidden
 * textarea + execCommand because clipboard.writeText needs a secure context,
 * and the bridge is routinely reached over plain http on a LAN address.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className,
  size = 12,
  showLabel = false,
}: {
  value: string | (() => string);
  label?: string;
  copiedLabel?: string;
  className?: string;
  size?: number;
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onClick = useCallback(async () => {
    const text = typeof value === "function" ? value() : value;
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      title={copied ? copiedLabel : label}
      aria-label={copied ? copiedLabel : label}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground hover:bg-secondary",
        className,
      )}
    >
      {copied ? (
        <Check size={size} className="text-success" />
      ) : (
        <Copy size={size} />
      )}
      {showLabel && <span>{copied ? copiedLabel : label}</span>}
    </button>
  );
}
