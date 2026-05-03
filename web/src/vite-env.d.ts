/// <reference types="vite/client" />

// Augment Vite's `ImportMetaEnv` with the bridge-specific env vars
// consumed by the SPA. Adding the keys here lets us use
// `import.meta.env.VITE_*` directly without per-call casts.
interface ImportMetaEnv {
  /** Override the API base URL (e.g. cross-origin dev). Empty = same-origin. */
  readonly VITE_API_BASE?: string;
  /**
   * Operator opt-in for the "Skip permissions" mode in the composer.
   * "1" = show the bypass option AND treat it as the implicit default
   * for brand-new sessions. Server gates the same flag in
   * `isValidUserPermissionMode`.
   */
  readonly VITE_BRIDGE_ALLOW_BYPASS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
