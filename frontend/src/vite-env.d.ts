/// <reference types="vite/client" />

// Build-time constants injected by vite `define` (see vite.config.ts). Declared here so
// `tsc --noEmit` (which runs before `vite build`) sees them as typed globals.
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
