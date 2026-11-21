// Ambient declaration for the untyped `qrcode` package (no bundled .d.ts).
// NOTE: the deployed .mjs modules (dots-runtime / model-hub / sponge-client /
// yu-remote-commander) are NOT declared here - `declare module` with an
// absolute path does not match (verified 2026-11-21). They are mapped via
// tsconfig `paths` to stubs in /types-external instead.
declare module 'qrcode' {
  const QRCode: any;
  export default QRCode;
}
