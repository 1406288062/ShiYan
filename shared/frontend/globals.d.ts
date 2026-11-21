export {};

declare global {
  interface Window {
    // App-wide plugin APIs attached at runtime (see app.ts, platform.ts,
    // workbench-dots-panels.ts). Typed as `any` for now; tighten to proper
    // interfaces as a follow-up.
    shiyan: any;
    ShiYanPlatform: any;
    ShiYanDotsPanels: any;
    ShiYanAccount: any;
    ShiYanV22: any;
    ShiYanV2: any;
    ShiYanSchedules: any;
    ShiYanOutput: any;
    ShiYanPhotoStatus: any;
    ShiYanSteps: any;
    ShiYanUploadPriority: any;
    ShiYanSettings: any;
    ShiYanChanges: any;
    ShiYanMessageDetails: any;
    ShiYanExecution: any;
    ShiYanSpongeIntegration: any;
    ShiYanShadowParser: any;
    ShiYanPhotoArchive: any;
    ShiYanDotsVoiceOrb: any;
    ShiYanComposerKeys: any;
    ShiYanAvatar: any;
    ShiYanKnowledge: any;
    ShiYanEnhancementTiming: any;
    ShiYanDots: any;
    ShiYanCosTransfer: any;
    ShiYanMemory: any;
    ShiYanDigitalPeople: any;
    webkit: any;
    workbench: any;
    __SHIYAN_DOTS_READY__: any;
    __SHIYAN_DOTS_INSTALLED__: any;
    __SHIYAN_DOTS_ACTIVATION_READY__: any;
    __SHIYAN_DOTS_PET_READY__: any;
    __ShiYanAccountTimings: any;
    showSaveFilePicker: any;
    markdownit: any;
    webkitSpeechRecognition: any;
    Terminal: any;
    FitAddon: any;
  }
}
