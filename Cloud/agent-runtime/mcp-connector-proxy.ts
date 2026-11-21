// Dots Codex MCP stdio bridge. It deliberately routes through the same
// owner-scoped connector service used by ordinary conversations and tenants.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpConnectors } from './mcp-connectors.ts';

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
const metaTools = [
  {
    name: 'mcp_list_tools',
    description: 'Search this connected MCP service for the real tools relevant to the current task. Always call this first with a short query describing the desired operation. Returns matching tool names, descriptions and exact input schemas. This only discovers tools; it does not modify data.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What you want to do, e.g. create an online document, search the web, read a wiki page' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 12 } }, required: ['query'], additionalProperties: false }
  },
  {
    name: 'mcp_call_tool',
    description: 'Call one real tool on this connected MCP service. Use the exact tool name and input schema returned by mcp_list_tools. The operation may create or modify external data; only call it when the user requested that action.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Exact tool name returned by mcp_list_tools' }, arguments: { type: 'object', description: 'Arguments matching that tool input schema', additionalProperties: true } }, required: ['name'], additionalProperties: false }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: metaTools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = String(request.params?.name || '');
  const args = request.params?.arguments || {};
  try {
    if (name === 'mcp_list_tools') {
      const query = String(args.query || '').trim().toLowerCase();
      if (!query) return { content: [{ type: 'text', text: 'query is required' }], isError: true };
      const result = await connectors.call(owner, connectorId, 'tools/list', {});
      const all = Array.isArray(result?.tools) ? result.tools : [];
      const terms = new Set(query.match(/[a-z0-9_.-]+|[\u4e00-\u9fff]{2,}/g) || []);
      // Chinese descriptions often use near-synonyms; score both whole terms and character bigrams.
      for (const term of [...terms]) if (/[\u4e00-\u9fff]/.test(term) && term.length > 2) {
        for (let i = 0; i < term.length - 1; i++) terms.add(term.slice(i, i + 2));
      }
      const ranked = all.map(tool => {
        const haystack = (String(tool.name || '') + ' ' + String(tool.description || '')).toLowerCase();
        let score = 0;
        if (haystack.includes(query)) score += 20;
        for (const term of terms) if (term.length > 1 && haystack.includes(term)) score += term.length > 3 ? 3 : 2;
        if (String(tool.name || '').toLowerCase().includes(query)) score += 12;
        return { tool, score };
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || String(a.tool.name).localeCompare(String(b.tool.name)));
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 12));
      const tools = ranked.slice(0, limit).map(({ tool }) => ({ name: tool.name, description: String(tool.description || '').slice(0, 12000), inputSchema: tool.inputSchema || { type: 'object', properties: {} } }));
      return { content: [{ type: 'text', text: JSON.stringify({ connector: connectorId, totalAvailable: all.length, matched: tools.length, tools }) }] };
    }
    if (name === 'mcp_call_tool') {
      const toolName = String(args.name || '').trim();
      if (!toolName || toolName.length > 200) return { content: [{ type: 'text', text: 'A valid tool name is required' }], isError: true };
      return await connectors.call(owner, connectorId, 'tools/call', { name: toolName, arguments: args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {} });
    }
    return { content: [{ type: 'text', text: 'Unknown proxy tool' }], isError: true };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error?.message || error).slice(0, 4000) }] };
  }
});
await server.connect(new StdioServerTransport());
