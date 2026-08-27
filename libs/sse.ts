export type SseSend = (event: string, data: unknown) => void;

export interface CreateSseResponseOptions {
  onStart: (send: SseSend) => (() => void) | void;
  signal?: AbortSignal;
  keepaliveMs?: number;
}

export function createSseResponse(options: CreateSseResponseOptions): Response {
  const { onStart, signal, keepaliveMs } = options;
  const encoder = new TextEncoder();
  let closed = false;
  let ka: ReturnType<typeof setInterval> | null = null;
  let closeRef: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const state: { teardown: (() => void) | undefined } = { teardown: undefined };

      const close = () => {
        if (closed) return;
        closed = true;
        if (ka !== null) {
          clearInterval(ka);
          ka = null;
        }
        try { state.teardown?.(); } catch { }
        try { controller.close(); } catch { }
        if (signal) {
          try { signal.removeEventListener("abort", close); } catch { }
        }
      };

      closeRef = close;

      const send: SseSend = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          close();
        }
      };

      state.teardown = onStart(send) ?? undefined;

      if (closed) {
        try { state.teardown?.(); } catch { }
        return;
      }

      if (keepaliveMs && keepaliveMs > 0) {
        ka = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
          } catch {
            close();
          }
        }, keepaliveMs);
      }

      if (signal) {
        if (signal.aborted) {
          close();
        } else {
          signal.addEventListener("abort", close);
        }
      }
    },
    cancel() {
      closeRef?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
