import { describe, expect, it } from "vitest";
import { derivePushState } from "../client/usePushSubscribe";

/**
 * `/settings` logged `Hydration failed` on every load, pointing at the push
 * notifications card. The cause was feature detection in a `useState`
 * initialiser: on the server `typeof window === "undefined"` made
 * `isSupported()` false and the card rendered "Not supported in this browser"
 * with a disabled button; on the browser's first render the same initialiser
 * saw a real `window` and rendered "Not enabled on this device" with an
 * enabled one. Two different trees for the same render pass.
 *
 * The invariant that fixes it is the one asserted here: `supported === null`
 * is what BOTH the server snapshot and the hydrating client see, so it has to
 * map to a single output. Everything browser-specific happens strictly after.
 */
describe("derivePushState", () => {
  it("gives the server and the hydrating client the same answer", () => {
    // `useSyncExternalStore`'s server snapshot is `null`, and React hands that
    // same value to the first client render. Same input, same output — which
    // is the whole of what hydration checks.
    const serverRender = derivePushState(null, null);
    const firstClientRender = derivePushState(null, null);
    expect(serverRender).toBe(firstClientRender);
    expect(serverRender).toBe("checking");
  });

  it("does not claim the browser is unsupported before it has looked", () => {
    // The old code's server answer. Rendering it during hydration is exactly
    // the mismatch, and it is also just wrong on a browser that does support
    // push.
    expect(derivePushState(null, null)).not.toBe("unsupported");
  });

  it("reports unsupported only once detection has actually run", () => {
    expect(derivePushState(false, null)).toBe("unsupported");
    // A stale probe cannot outrank the detection result.
    expect(derivePushState(false, "subscribed")).toBe("unsupported");
  });

  it("stays in checking on a supported browser until the probe answers", () => {
    expect(derivePushState(true, null)).toBe("checking");
  });

  it("reports whatever the probe found on a supported browser", () => {
    for (const probed of ["default", "denied", "subscribed"] as const) {
      expect(derivePushState(true, probed)).toBe(probed);
    }
  });
});
