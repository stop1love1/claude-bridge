// Browser-side voice input using the Web Speech API. No server
// roundtrip, no extra deps. Streams interim transcripts via
// `onTranscript` so the textarea grows as you talk; the final commit
// lands when recognition ends.
//
// Adapted from the Next-app `_components/MicButton.tsx` — Next-only
// imports replaced with React/Vite equivalents and toast feedback
// wired to our `useToast` from `@/components/Toasts`.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Mic, MicOff } from "lucide-react";
import { useToast } from "@/components/Toasts";

interface SpeechRecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResult };
}
interface SpeechRecognitionErrorEvent extends Event {
  error?: string;
}
interface PermissionStatusLike extends EventTarget {
  state: "granted" | "denied" | "prompt";
  onchange: ((this: PermissionStatusLike, ev: Event) => unknown) | null;
}
interface PermissionsLike {
  query: (permissionDesc: { name: string }) => Promise<PermissionStatusLike>;
}
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
}
type SRCtor = new () => SpeechRecognition;

function getSR(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Browser-API capability detection via `useSyncExternalStore` so the
// hydration flip from "false" (first paint) to "true / false" (real
// client value) doesn't need a `useState + setState in effect` pair
// that the React hooks linter flags.
function noopSubscribe() {
  return () => {};
}
function getSupportedClient(): boolean {
  return !!getSR();
}
function getSupportedServer(): boolean {
  return false;
}

export interface MicButtonProps {
  /** BCP-47 language tag, e.g. "en-US". Defaults to `navigator.language`. */
  lang?: string;
  /** Receives interim + final transcripts. `opts.final` distinguishes them. */
  onTranscript: (text: string, opts: { final: boolean }) => void;
  /** Optional listener for parent UIs that want to mirror recording state. */
  onListeningChange?: (listening: boolean) => void;
}

export function MicButton({
  lang,
  onTranscript,
  onListeningChange,
}: MicButtonProps) {
  const supported = useSyncExternalStore(
    noopSubscribe,
    getSupportedClient,
    getSupportedServer,
  );
  const [recording, setRecording] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [hasInputDevice, setHasInputDevice] = useState(true);
  const ref = useRef<SpeechRecognition | null>(null);
  const toast = useToast();
  // Lazy default — `navigator` is undefined during SSR, resolve only on
  // the client. The lazy initializer ensures it runs once on mount.
  const [defaultLang] = useState(() =>
    typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US",
  );
  const effectiveLang = lang ?? defaultLang;

  // Notify parents when recording state flips.
  useEffect(() => {
    onListeningChange?.(recording);
  }, [recording, onListeningChange]);

  // Cleanup any in-flight recognition on unmount.
  useEffect(() => {
    return () => {
      try {
        ref.current?.abort();
      } catch {
        /* noop */
      }
    };
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    // Override the built-in `permissions` property rather than intersect:
    // the DOM `Permissions.query` is overloaded and returns the wider
    // `PermissionStatus`, making assignments to `PermissionStatusLike`
    // fail typechecking.
    const nav = navigator as Omit<Navigator, "permissions"> & {
      permissions?: PermissionsLike;
      mediaDevices?: MediaDevices;
    };
    let cancelled = false;
    let permStatus: PermissionStatusLike | null = null;

    const refreshDevices = async () => {
      if (!nav.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await nav.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const hasMic = devices.some((d) => d.kind === "audioinput");
        setHasInputDevice(hasMic);
      } catch {
        // If the browser blocks device enumeration details, keep enabled.
        if (!cancelled) setHasInputDevice(true);
      }
    };

    const onDeviceChange = () => {
      void refreshDevices();
    };
    void refreshDevices();
    nav.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

    const bindPermission = async () => {
      if (!nav.permissions?.query) return;
      try {
        // TS DOM lib doesn't include "microphone" in all targets.
        permStatus = await nav.permissions.query({ name: "microphone" });
        if (cancelled) return;
        setBlocked(permStatus.state === "denied");
        permStatus.onchange = () => {
          setBlocked(permStatus?.state === "denied");
        };
      } catch {
        // Ignore unsupported Permissions API browsers.
      }
    };
    void bindPermission();

    return () => {
      cancelled = true;
      nav.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      if (permStatus) permStatus.onchange = null;
    };
  }, []);

  const toggle = useCallback(() => {
    const SR = getSR();
    if (!SR) return;
    if (recording) {
      ref.current?.stop();
      return;
    }
    // Let users retry after they re-enable mic permission in browser UI.
    setBlocked(false);
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = effectiveLang;
    let finalBuf = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript;
        if (res.isFinal) finalBuf += text;
        else interim += text;
      }
      if (finalBuf) {
        onTranscript(finalBuf, { final: true });
        finalBuf = "";
      }
      if (interim) onTranscript(interim, { final: false });
    };
    r.onerror = (e) => {
      const err = (e as SpeechRecognitionErrorEvent).error ?? "";
      // Permission-denied states should show a "mic blocked" affordance.
      if (
        err === "not-allowed" ||
        err === "service-not-allowed" ||
        err === "permission-denied" ||
        err === "audio-capture"
      ) {
        setBlocked(true);
        toast.error("microphone blocked", "Allow mic access in your browser to use voice input.");
      } else if (err) {
        toast.error("voice input error", err);
      }
      setRecording(false);
    };
    r.onend = () => {
      setRecording(false);
      ref.current = null;
    };
    ref.current = r;
    try {
      r.start();
      setRecording(true);
      setBlocked(false);
    } catch {
      /* already started / transient */
    }
  }, [recording, effectiveLang, onTranscript, toast]);

  if (!supported) return null;
  const disabled = blocked || !hasInputDevice;

  const Icon = blocked ? MicOff : Mic;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      className={`inline-flex items-center justify-center w-7 h-7 rounded-md border ${
        blocked
          ? "bg-destructive/15 border-destructive/40 text-destructive"
          : recording
            ? "bg-primary/15 border-primary/40 text-primary"
            : disabled
              ? "border-border text-muted-foreground/40 bg-muted/20 cursor-not-allowed"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
      }`}
      title={
        blocked
          ? "Microphone is blocked by browser permission"
          : !hasInputDevice
            ? "No microphone input device available"
            : recording
              ? "Recording… click to stop"
              : "Voice input"
      }
    >
      <Icon size={13} className={recording ? "animate-pulse" : ""} />
    </button>
  );
}
