// Executor stdio MCP bridge: low-level browser actions for ONE claimed browser task.
// The task id and its claim token come from the runtime environment; the model cannot address
// another task or account. Secrets are typed by the browser host and never returned here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { browserAgentRequest, defaultBrowserSocket } from './browser-agent.ts';
import { EXEC_TOOLS } from './browser-tool-defs.ts';

const taskId = String(process.env.SHIYAN_BROWSER_TASK || ''), token = String(process.env.SHIYAN_BROWSER_EXEC_TOKEN || '');
const socketPath = process.env.SHIYAN_BROWSER_SOCKET || defaultBrowserSocket(process.env.SHIYAN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url))));
if (!taskId || !token) { process.stderr.write('Missing browser task binding\n'); process.exit(2); }



const server = new Server({ name: 'shiyan-browser-exec', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: EXEC_TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = String(request.params?.name || '');
  if (!EXEC_TOOLS.some(tool => tool.name === name)) return { isError: true, content: [{ type: 'text', text: '未知的浏览器操作' }] };
  const args = request.params?.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {};
  try {
    const { result } = await browserAgentRequest(socketPath, '/exec/call', { task_id: taskId, token, tool: name, args }, { timeoutMs: 2 * 60 * 60_000 });
    if (name === 'screenshot' && result?.image) {
      const { image, mimeType, ...rest } = result;
      return { content: [{ type: 'image', data: image, mimeType: mimeType || 'image/jpeg' }, { type: 'text', text: JSON.stringify(rest) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result).slice(0, 60_000) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String((error as any)?.message || error).slice(0, 2000) }] };
  }
});
await server.connect(new StdioServerTransport());
