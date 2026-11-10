// Runs INSIDE the agent sandbox as a stdio MCP server. It is a pure byte relay to the host tool
// socket of one agent session (/run/shiyan/<session>.sock): the host implements the MCP server,
// so tool handlers (browser, Dots task control, devices, connectors) run on the host, bound to the
// session's account and task. Nothing in the container can choose another account or task.
import net from 'node:net';

const socketPath = process.argv[2];
if (!socketPath) { process.stderr.write('usage: mcp-relay.mjs <socket>\n'); process.exit(2); }
const socket = net.createConnection(socketPath);
socket.on('error', error => { process.stderr.write('[mcp-relay] ' + error.message + '\n'); process.exit(1); });
socket.on('close', () => process.exit(0));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
process.stdin.on('end', () => socket.end());
