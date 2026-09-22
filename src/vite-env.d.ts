/// <reference types="vite/client" />

/**
 * Environment variables the app reads.
 *
 * Declared explicitly so a typo in a variable name fails the typecheck instead of
 * silently producing `undefined` and a confusing fallback at runtime.
 */
interface ImportMetaEnv {
  /** Base URL of the FastAPI service. Defaults to http://localhost:8000. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
