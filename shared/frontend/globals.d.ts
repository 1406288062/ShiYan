export {};

declare global {
  interface Window {
    // App-wide plugin APIs attached at runtime (see app.ts, platform.ts,
    // workbench-dots-panels.ts). Typed as `any` for now; tighten to proper
    // interfaces as a follow-up.
    shiyan: any;
    ShiYanPlatform: any;
    ShiYanDotsPanels: any;
  }
}
