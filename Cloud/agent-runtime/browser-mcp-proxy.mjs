// Dots stdio MCP bridge for the server browser: browse / windows / search / open / find.
// The owner and the task origin come only from the runtime environment, so a model cannot reach
// another account's windows or pretend a scheduled task was started in a conversation.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { browserAgentRequest, defaultBrowserSocket } from './browser-agent.mjs';
import { BROWSER_TOOLS } from './browser-tool-defs.mjs';

const owner = String(process.env.SHIYAN_MCP_OWNER || '');
const origin = ['chat', 'scheduled', 'push', 'webapp'].includes(process.env.SHIYAN_BROWSER_ORIGIN) ? process.env.SHIYAN_BROWSER_ORIGIN : 'chat';
const socketPath = process.env.SHIYAN_BROWSER_SOCKET || defaultBrowserSocket(process.env.SHIYAN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url))));
if (!owner || owner.length > 512) { process.stderr.write('Missing or invalid browser bridge owner\n'); process.exit(2); }


const server = new Server({ name: 'shiyan-browser', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: BROWSER_TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = String(request.params?.name || '');
  if (!BROWSER_TOOLS.some(tool => tool.name === name)) return { isError: true, content: [{ type: 'text', text: '未知的浏览器工具' }] };
  const args = request.params?.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {};
  try {
    const data = await browserAgentRequest(socketPath, '/dots/call', { owner, origin, tool: name, args }, { timeoutMs: name === 'search' || name === 'open' ? 90_000 : 120_000 });
    return { content: [{ type: 'text', text: JSON.stringify(data.result).slice(0, 60_000) }], structuredContent: data.result };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error?.message || error).slice(0, 2000) }] };
  }
});
await server.connect(new StdioServerTransport());
