// Dots stdio bridge to the owner-bound Sponge connector. The owner comes only
// from the runtime environment, so a model cannot reach another account's devices.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createSpongeClient } from './sponge-client.mjs';

export const SPONGE_TOOLS = ['list_devices', 'run_device_tool', 'get_tool_result'];

const owner = String(process.env.SHIYAN_MCP_OWNER || '');
if (!owner || owner.length > 128) {
  process.stderr.write('Missing or invalid Sponge bridge owner\n');
  process.exit(2);
}
const client = createSpongeClient();
const server = new Server({ name: 'shiyan-sponge', version: '1.0.0' }, { capabilities: { tools: {} } });
const failure = text => ({ isError: true, content: [{ type: 'text', text: String(text).slice(0, 4000) }] });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const status = await client.status(owner).catch(() => null);
  if (!status?.connected) return { tools: [] };
  const result = await client.rpc(owner, 'tools/list', {});
  return { tools: (result?.tools || []).filter(tool => SPONGE_TOOLS.includes(tool.name)) };
});

server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = String(request.params?.name || '');
  if (!SPONGE_TOOLS.includes(name)) return failure('Unknown Sponge tool');
  const args = request.params?.arguments;
  try {
    const status = await client.status(owner);
    if (!status?.connected) return failure('海绵宝宝还没有连接。请在拾燕的连接器里连接海绵宝宝。');
    if (name === 'list_devices' && !status.devices?.length) return failure('海绵宝宝已连接，但还没有配对任何设备。请在电脑上安装海绵宝宝客户端并完成配对。');
    return await client.rpc(owner, 'tools/call', { name, arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {} });
  } catch (error) {
    return failure(error?.message || error);
  }
});

await server.connect(new StdioServerTransport());
