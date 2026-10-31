// Dots Codex MCP stdio bridge. It deliberately routes through the same
// owner-scoped connector service used by ordinary conversations and tenants.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpConnectors } from './mcp-connectors.mjs';

const owner = String(process.env.SHIYAN_MCP_OWNER || '');
const connectorId = String(process.env.SHIYAN_MCP_ID || '');
if (!owner || !connectorId || owner.length > 128 || connectorId.length > 128) {
  process.stderr.write('Missing or invalid connector bridge identity\n');
  process.exit(2);
}
const connectors = mcpConnectors();
if (!connectors.has(owner, connectorId)) {
  process.stderr.write('Connector is not owned by this account\n');
  process.exit(2);
}
const server = new Server(
  { name: 'shiyan-connector-' + connectorId, version: '1.0.0' },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await connectors.call(owner, connectorId, 'tools/list', {});
  return { tools: Array.isArray(result?.tools) ? result.tools : [] };
});
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    return await connectors.call(owner, connectorId, 'tools/call', {
      name: String(request.params?.name || ''),
      arguments: request.params?.arguments || {}
    });
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error?.message || error).slice(0, 4000) }] };
  }
});
await server.connect(new StdioServerTransport());
