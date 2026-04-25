"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";

interface SpeechRecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResult };
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

/**
 * Browser-side voice input using the Web Speech API. No server roundtrip,
 * no extra deps. Streams interim transcripts via `onTranscript` so the
 * textarea grows as you talk; final commit lands when recognition ends.
 */
export function MicButton({
  lang,
  onTranscript,
}: {
  lang?: string;
  onTranscript: (text: string, isFinal: boolean) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const ref = useRef<SpeechRecognition | null>(null);
  // Lazy default — `navigator` is undefined during SSR, so resolve only
  // on the client. The lazy initializer ensures this runs once on mount,
  // not on every render.
  const [defaultLang] = useState(() =>
    typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US",
  );
  const effectiveLang = lang ?? defaultLang;

  useEffect(() => {
    setSupported(!!getSR());
    return () => { try { ref.current?.abort(); } catch { /* noop */ } };
  }, []);

  const toggle = useCallback(() => {
    const SR = getSR();
    if (!SR) return;
    if (recording) {
      ref.current?.stop();
      return;
    }
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
        onTranscript(finalBuf, true);
        finalBuf = "";
      }
      if (interim) onTranscript(interim, false);
    };
    r.onerror = () => { setRecording(false); };
    r.onend = () => { setRecording(false); ref.current = null; };
    ref.current = r;
    try { r.start(); setRecording(true); } catch { /* already started */ }
  }, [recording, effectiveLang, onTranscript]);

  if (!supported) return null;

  const Icon = recording ? MicOff : Mic;
  return (
    <button
      type="button"
      onClick={toggle}
      className={`inline-flex items-center justify-center w-7 h-7 rounded-md border ${
        recording
          ? "bg-destructive/15 border-destructive/40 text-destructive"
          : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
      }`}
      title={recording ? "Stop recording" : "Voice input"}
    >
      <Icon size={13} className={recording ? "animate-pulse" : ""} />
    </button>
  );
}
