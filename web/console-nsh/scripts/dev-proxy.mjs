// One origin for Console development with hot reload: the Console's API (`/api`, its WebSockets
// included) goes to a running `morph console`, everything else to nsh's web dev server
// (`nsh run --target web`), which serves the page and pushes hot updates over its own `/ws`.
// The Console calls its API on the page's own origin, so the two have to share one.
//
// Usage: node scripts/dev-proxy.mjs [--port 9090] [--api 127.0.0.1:9080] [--app 127.0.0.1:8790]
import http from "node:http";
import net from "node:net";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const port = Number(flag("port", "9090"));
const target = (value) => {
  const [host, p] = value.replace(/^https?:\/\//, "").split(":");
  return { host: host || "127.0.0.1", port: Number(p) };
};
const api = target(flag("api", "127.0.0.1:9080"));
const app = target(flag("app", "127.0.0.1:8790"));

const upstream = (url) => (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?") ? api : app);

// A page load (not a script or a fetch) outside /api: the Console's own routes, such as /chat,
// which nsh's dev server does not know.
const isPageLoad = (req) =>
  req.method === "GET" &&
  (req.headers["sec-fetch-dest"] === "document" || String(req.headers.accept || "").includes("text/html"));

const server = http.createServer((req, res) => {
  const to = upstream(req.url || "/");
  // nsh serves its page at / only, so a reload at /chat would be a 404: serve that page for every
  // route, with a <base> so its relative files (./nsh.js, ./nsh-host.js) still load from /. The
  // address stays, and the Console opens the route from it.
  const page = to === app && isPageLoad(req);
  const headers = { ...req.headers, host: `${to.host}:${to.port}` };
  if (page) delete headers["accept-encoding"];
  const forward = http.request(
    { host: to.host, port: to.port, method: req.method, path: page ? "/" : req.url, headers },
    (reply) => {
      if (!page) {
        res.writeHead(reply.statusCode || 502, reply.headers);
        reply.pipe(res);
        return;
      }
      const chunks = [];
      reply.on("data", (chunk) => chunks.push(chunk));
      reply.on("end", () => {
        const html = Buffer.concat(chunks).toString("utf8").replace(/<head>/i, '<head>\n<base href="/">');
        const { "content-length": _length, etag: _etag, ...rest } = reply.headers;
        res.writeHead(reply.statusCode || 502, { ...rest, "cache-control": "no-store" });
        res.end(html);
      });
    },
  );
  forward.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`dev proxy: ${to.host}:${to.port} is not answering (${error.code || error.message})\n`);
  });
  req.pipe(forward);
});

// WebSockets (the Console's streams, nsh's hot updates): pass the upgrade through as raw bytes.
server.on("upgrade", (req, socket, head) => {
  const to = upstream(req.url || "/");
  const peer = net.connect(to.port, to.host, () => {
    const headers = { ...req.headers, host: `${to.host}:${to.port}` };
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    peer.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) peer.write(head);
    peer.pipe(socket);
    socket.pipe(peer);
  });
  const close = () => {
    socket.destroy();
    peer.destroy();
  };
  peer.on("error", close);
  socket.on("error", close);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dev proxy: http://127.0.0.1:${port}/  (/api → ${api.host}:${api.port}, the rest → ${app.host}:${app.port})`);
});
