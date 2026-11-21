import http from "node:http";
import net from "node:net";

let proxyPromise: Promise<{server: any; port: number}> | null = null;

function parseAuthority(authority) {
  const raw = String(authority || "").trim();
  if (!raw) return null;

  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return null;
    const host = raw.slice(1, end);
    const port = Number(raw.slice(end + 1).replace(/^:/, "") || 443);
    return { host, port };
  }

  const index = raw.lastIndexOf(":");
  if (index < 0) return { host: raw, port: 443 };
  return {
    host: raw.slice(0, index),
    port: Number(raw.slice(index + 1) || 443)
  };
}

function validTarget(target) {
  if (!target?.host || !Number.isInteger(target.port)) return false;
  if (target.port !== 443) return false;
  const host = target.host.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === "::1") return false;
  return true;
}

export function ensureHttpConnectProxy() {
  if (proxyPromise) return proxyPromise;

  proxyPromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(405, {
        "content-type": "text/plain; charset=utf-8",
        "connection": "close"
      });
      res.end("CONNECT only\n");
    });

    server.on("connect", (req, clientSocket, head) => {
      const target = parseAuthority(req.url);
      if (!validTarget(target)) {
        clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }

      const upstream = net.connect(target!.port, target!.host);

      const closeBoth = () => {
        try { upstream.destroy(); } catch {}
        try { clientSocket.destroy(); } catch {}
      };

      upstream.once("connect", () => {
        clientSocket.write(
          "HTTP/1.1 200 Connection Established\r\n" +
          "Proxy-Agent: Dots-Mac-Executor\r\n\r\n"
        );
        if (head?.length) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });

      upstream.once("error", closeBoth);
      clientSocket.once("error", closeBoth);
    });

    server.once("error", (error) => {
      proxyPromise = null;
      reject(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        proxyPromise = null;
        reject(new Error("failed to bind HTTP CONNECT proxy"));
        return;
      }
      server.unref();
      resolve({ server, port: address.port });
    });
  });

  return proxyPromise;
}
