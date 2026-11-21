import { Codex } from "@openai/codex-sdk";
import os from "node:os";

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return JSON.parse(data || "{}");
}

function buildInput(payload) {
  const items = [];
  const prompt = String(payload.prompt || "").trim();
  if (prompt) items.push({ type: "text", text: prompt });
  for (const imagePath of payload.images || []) {
    items.push({ type: "local_image", path: String(imagePath) });
  }
  return items.length === 1 && items[0].type === "text" ? items[0].text : items;
}
async function main() {
  const payload = await readStdin();
  const codexOptions = {};
  if (payload.codexPath) codexOptions.codexPathOverride = payload.codexPath;
  if (process.env.CODEX_API_KEY) codexOptions.apiKey = process.env.CODEX_API_KEY;
  const codex = new Codex(codexOptions);
  const thread = codex.startThread({
    model: payload.model || undefined,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    workingDirectory: payload.workingDirectory || os.tmpdir(),
    skipGitRepoCheck: true,
    modelReasoningEffort: payload.reasoningEffort || "low",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
  });

  const input = buildInput(payload);
  const options = payload.outputSchema
    ? { outputSchema: payload.outputSchema }
    : undefined;
  const turn = await thread.run(input, options);
  process.stdout.write(JSON.stringify({
    ok: true,
    finalResponse: turn.finalResponse || "",
    usage: turn.usage || null,
    threadId: thread.id || null,
  }));
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
  }));
  process.exitCode = 1;
});
