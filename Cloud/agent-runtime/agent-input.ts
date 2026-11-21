import { editedBranchInput } from './edit-history.ts';

// Codex CLI requires nonempty stdin even when images are passed with --image.
// Keep the stored user prompt intact; supply context only for image-only turns.
export function agentPrompt(prompt: any, history: any, imageCount: any) {
  const text = prompt.trim() || !imageCount
    ? prompt
    : '用户本轮仅上传了图片，没有附加文字。请结合当前对话理解图片；如果无法确定用途，请询问用户希望如何处理。';
  return editedBranchInput(history || [], text);
}
