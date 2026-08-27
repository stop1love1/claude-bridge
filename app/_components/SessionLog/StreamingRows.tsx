"use client";


import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import { StreamingAssistantRow } from "./views";
import {
  subscribePartialKeys,
  subscribePartialText,
} from "./partialsStore";

export const StreamingPartialsList = memo(function StreamingPartialsList({
  sessionId,
  scrollerRef,
  autoScroll,
}: {
  sessionId: string;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  autoScroll: boolean;
}) {
  const sub = useMemo(() => subscribePartialKeys(sessionId), [sessionId]);
  const keys = useSyncExternalStore(sub.subscribe, sub.getSnapshot, sub.getSnapshot);
  if (keys.length === 0) return null;
  return (
    <>
      {keys.map((id) => (
        <StreamingPartialRowConnected
          key={`live-${id}`}
          sessionId={sessionId}
          messageId={id}
          scrollerRef={scrollerRef}
          autoScroll={autoScroll}
        />
      ))}
    </>
  );
});

function StreamingPartialRowConnected({
  sessionId,
  messageId,
  scrollerRef,
  autoScroll,
}: {
  sessionId: string;
  messageId: string;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  autoScroll: boolean;
}) {
  const sub = useMemo(
    () => subscribePartialText(sessionId, messageId),
    [sessionId, messageId],
  );
  const text = useSyncExternalStore(sub.subscribe, sub.getSnapshot, sub.getSnapshot);
  const autoScrollRef = useRef(autoScroll);
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    const r = requestAnimationFrame(() => {
      if (autoScrollRef.current && scrollerRef.current) {
        scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(r);
  }, [text, scrollerRef]);
  if (!text.trim()) return null;
  return <StreamingAssistantRow text={text} />;
}

function SpawnPlaceholder() {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setStalled(true), 30_000);
    return () => clearTimeout(h);
  }, []);
  return (
    <div className="flex items-start gap-2 text-muted-foreground text-[12px]">
      <Loader2 size={14} className="animate-spin shrink-0 mt-0.5 text-primary" />
      <span className="leading-relaxed">
        {stalled
          ? "Still spawning. Check the terminal where you started the bridge for errors."
          : "Spawning coordinator… first response usually arrives in 5-15s."}
      </span>
    </div>
  );
}

export function EmptyOrStreaming({
  sessionId,
  scrollerRef,
  autoScroll,
}: {
  sessionId: string;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  autoScroll: boolean;
}) {
  const sub = useMemo(() => subscribePartialKeys(sessionId), [sessionId]);
  const keys = useSyncExternalStore(sub.subscribe, sub.getSnapshot, sub.getSnapshot);
  if (keys.length === 0) {
    return <SpawnPlaceholder key={sessionId} />;
  }
  return (
    <StreamingPartialsList
      sessionId={sessionId}
      scrollerRef={scrollerRef}
      autoScroll={autoScroll}
    />
  );
}
