import * as http from "node:http";
import type { Duplex } from "node:stream";
import { ARROW_SVG, renderPage } from "./pages.js";
import { RouteStore, type RouteMapping } from "./routes.js";
import { escapeHtml } from "./utils.js";

export const PLESS_GATEWAY_HEADER = "X-Pless-Gateway";
export const GATEWAY_COOKIE = "pless_route";

const PORTLESS_HOPS_HEADER = "x-portless-hops";
const MAX_PROXY_HOPS = 5;

function routeLabel(route: RouteMapping): string {
  return route.appName || route.hostname.split(".")[0] || route.hostname;
}

function sortedRoutes(routes: RouteMapping[]): RouteMapping[] {
  return [...routes].sort((a, b) => {
    const appCmp = routeLabel(a).localeCompare(routeLabel(b));
    if (appCmp !== 0) return appCmp;
    return a.port - b.port;
  });
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies.set(key, value);
  }
  return cookies;
}

function selectedRoute(routes: RouteMapping[], req: http.IncomingMessage): RouteMapping | null {
  const selected = parseCookies(req.headers.cookie).get(GATEWAY_COOKIE);
  if (!selected) return null;
  let decoded = selected;
  try {
    decoded = decodeURIComponent(selected);
  } catch {
    return null;
  }
  return routes.find((route) => route.id === decoded) ?? null;
}

function clearCookieHeader(): string {
  return `${GATEWAY_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function selectCookieHeader(route: RouteMapping): string {
  return `${GATEWAY_COOKIE}=${encodeURIComponent(route.id)}; Path=/; HttpOnly; SameSite=Lax`;
}

function routeMeta(route: RouteMapping): string {
  const bits = [`:${route.port}`];
  if (route.folder) bits.push(route.folder);
  if (route.pid !== undefined) bits.push(`pid ${route.pid}`);
  return bits.join(" · ");
}

function renderGlobalDashboard(routes: RouteMapping[], host: string): string {
  const grouped = new Map<string, RouteMapping[]>();
  for (const route of sortedRoutes(routes)) {
    const app = routeLabel(route);
    grouped.set(app, [...(grouped.get(app) ?? []), route]);
  }

  const list =
    grouped.size > 0
      ? `<div class="section"><p class="label">Running apps</p><ul class="card">${[
          ...grouped.entries(),
        ]
          .map(([app, appRoutes]) => {
            const first = appRoutes[0];
            return `<li><a href="/${encodeURIComponent(app)}" class="card-link"><span class="name">${escapeHtml(app)}</span><span class="meta"><code class="port">${appRoutes.length} instance${appRoutes.length === 1 ? "" : "s"}</code><span class="arrow">${ARROW_SVG}</span></span></a>${first.cwd ? `<div class="gateway-sub">${escapeHtml(first.cwd)}</div>` : ""}</li>`;
          })
          .join("")}</ul></div>`
      : '<p class="empty">No apps running.</p>';

  return renderPage(
    200,
    "Tailscale Gateway",
    `<div class="content"><p class="desc"><strong>${escapeHtml(host)}</strong> is ready.</p>${list}</div>`
  );
}

function renderAppDashboard(app: string, routes: RouteMapping[], host: string): string {
  const appRoutes = sortedRoutes(routes.filter((route) => routeLabel(route) === app));
  const list =
    appRoutes.length > 0
      ? `<div class="section"><p class="label">Instances</p><ul class="card">${appRoutes
          .map((route) => {
            const href = `/${encodeURIComponent(app)}/${route.port}`;
            const command = route.command
              ? `<div class="gateway-sub">${escapeHtml(route.command)}</div>`
              : "";
            const cwd = route.cwd ? `<div class="gateway-sub">${escapeHtml(route.cwd)}</div>` : "";
            return `<li><a href="${href}" class="card-link"><span class="name">${escapeHtml(routeMeta(route))}</span><span class="meta"><code class="port">select</code><span class="arrow">${ARROW_SVG}</span></span></a>${cwd}${command}</li>`;
          })
          .join("")}</ul></div>`
      : `<p class="empty">No running instances for ${escapeHtml(app)}.</p>`;

  return renderPage(
    appRoutes.length > 0 ? 200 : 404,
    appRoutes.length > 0 ? app : "Not Found",
    `<div class="content"><p class="desc"><strong>${escapeHtml(host)}</strong> / ${escapeHtml(app)}</p>${list}<div class="section"><div class="terminal"><span class="prompt">$ </span>pless ${escapeHtml(app)} your-command</div></div></div>`
  );
}

function proxyHttp(
  route: RouteMapping,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  onError: (message: string) => void
): void {
  const hops = parseInt(req.headers[PORTLESS_HOPS_HEADER] as string, 10) || 0;
  if (hops >= MAX_PROXY_HOPS) {
    res.writeHead(508, { "Content-Type": "text/html", [PLESS_GATEWAY_HEADER]: "1" });
    res.end(
      renderPage(
        508,
        "Loop Detected",
        '<div class="content"><p class="desc">This request has passed through the gateway too many times.</p></div>'
      )
    );
    return;
  }

  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers[PORTLESS_HOPS_HEADER] = String(hops + 1);
  headers["x-forwarded-for"] = req.socket.remoteAddress || "127.0.0.1";
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string) || "https";
  headers["x-forwarded-port"] = (req.headers["x-forwarded-port"] as string) || "443";

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: route.port,
      path: req.url || "/",
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    onError(`Gateway proxy error for ${route.hostname}:${route.port}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/html", [PLESS_GATEWAY_HEADER]: "1" });
      res.end(
        renderPage(
          502,
          "Bad Gateway",
          '<div class="content"><p class="desc">The selected app is not responding.</p></div>'
        )
      );
    }
  });

  res.on("close", () => {
    if (!proxyReq.destroyed) proxyReq.destroy();
  });
  req.pipe(proxyReq);
}

function proxyUpgrade(
  route: RouteMapping,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  onError: (message: string) => void
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string) || "https";
  headers["x-forwarded-port"] = (req.headers["x-forwarded-port"] as string) || "443";

  const proxyReq = http.request({
    hostname: "127.0.0.1",
    port: route.port,
    path: req.url || "/",
    method: req.method,
    headers,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    let response = "HTTP/1.1 101 Switching Protocols\r\n";
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      response += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
    }
    response += "\r\n";
    socket.write(response);
    if (proxyHead.length > 0) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on("error", (err) => {
    onError(`Gateway WebSocket proxy error for ${route.hostname}:${route.port}: ${err.message}`);
    socket.destroy();
  });
  if (head.length > 0) proxyReq.write(head);
  proxyReq.end();
}

export function createGatewayServer(options: {
  store: RouteStore;
  onError?: (message: string) => void;
}): http.Server {
  const onError = options.onError ?? console.error;

  const server = http.createServer((req, res) => {
    res.setHeader(PLESS_GATEWAY_HEADER, "1");
    const host = String(req.headers.host || "").split(":")[0] || "tailscale";
    const routes = options.store.loadRoutes();
    const url = new URL(req.url || "/", "http://gateway");
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });

    if (url.pathname === "/_pless/health") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/_pless/clear") {
      res.writeHead(302, { Location: "/", "Set-Cookie": clearCookieHeader() });
      res.end();
      return;
    }

    if (segments.length === 0 || url.pathname === "/_pless") {
      const selected = selectedRoute(routes, req);
      if (segments.length === 0 && selected) {
        proxyHttp(selected, req, res, onError);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderGlobalDashboard(routes, host));
      return;
    }

    if (segments.length === 1) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderAppDashboard(segments[0], routes, host));
      return;
    }

    if (segments.length === 2 && /^\d+$/.test(segments[1])) {
      const port = parseInt(segments[1], 10);
      const route = routes.find(
        (candidate) => routeLabel(candidate) === segments[0] && candidate.port === port
      );
      if (!route) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end(renderAppDashboard(segments[0], routes, host));
        return;
      }
      res.writeHead(302, { Location: "/", "Set-Cookie": selectCookieHeader(route) });
      res.end();
      return;
    }

    const selected = selectedRoute(routes, req);
    if (selected) {
      proxyHttp(selected, req, res, onError);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": clearCookieHeader() });
    res.end(renderGlobalDashboard(routes, host));
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const route = selectedRoute(options.store.loadRoutes(), req);
    if (!route) {
      socket.destroy();
      return;
    }
    proxyUpgrade(route, req, socket, head, onError);
  });

  return server;
}
