import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATEWAY_COOKIE, createGatewayServer } from "./gateway.js";
import { RouteStore } from "./routes.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Expected TCP server address");
      resolve(addr.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function request(
  port: number,
  pathname: string,
  headers: http.OutgoingHttpHeaders = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        headers: {
          Host: "delta-bare.tail6624e2.ts.net",
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("createGatewayServer", () => {
  let tmpDir: string;
  let backend: http.Server | null = null;
  let gateway: http.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pless-gateway-test-"));
  });

  afterEach(async () => {
    if (gateway) {
      await close(gateway);
      gateway = null;
    }
    if (backend) {
      await close(backend);
      backend = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders running apps and app instances", async () => {
    const store = new RouteStore(tmpDir);
    store.addRoute("myapp.localhost", 4321, process.pid, false, true, {
      appName: "myapp",
      cwd: "/repo/myapp",
      command: "next dev",
      localUrl: "https://myapp.localhost",
      gatewayUrl: "https://delta-bare.tail6624e2.ts.net",
    });

    gateway = createGatewayServer({ store });
    const gatewayPort = await listen(gateway);

    const home = await request(gatewayPort, "/");
    expect(home.status).toBe(200);
    expect(home.body).toContain("Running apps");
    expect(home.body).toContain("myapp");
    expect(home.body).toContain("1 instance");

    const app = await request(gatewayPort, "/myapp");
    expect(app.status).toBe(200);
    expect(app.body).toContain("Instances");
    expect(app.body).toContain(":4321");
    expect(app.body).toContain("next dev");
  });

  it("selects an instance and proxies app paths at the gateway root", async () => {
    backend = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`backend:${req.url}`);
    });
    const backendPort = await listen(backend);

    const store = new RouteStore(tmpDir);
    store.addRoute("myapp.localhost", backendPort, process.pid, false, true, {
      appName: "myapp",
      localUrl: "https://myapp.localhost",
      gatewayUrl: "https://delta-bare.tail6624e2.ts.net",
    });

    gateway = createGatewayServer({ store });
    const gatewayPort = await listen(gateway);

    const selection = await request(gatewayPort, `/myapp/${backendPort}`);
    expect(selection.status).toBe(302);
    expect(selection.headers.location).toBe("/");
    const setCookie = selection.headers["set-cookie"]?.[0];
    expect(setCookie).toContain(`${GATEWAY_COOKIE}=`);

    const cookie = setCookie?.split(";")[0] ?? "";
    const proxied = await request(gatewayPort, "/api/ping?x=1", { Cookie: cookie });
    expect(proxied.status).toBe(200);
    expect(proxied.body).toBe("backend:/api/ping?x=1");
  });

  it("proxies selected one-segment asset paths that are not app names", async () => {
    backend = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(`module:${req.url}`);
    });
    const backendPort = await listen(backend);

    const store = new RouteStore(tmpDir);
    store.addRoute("myapp.localhost", backendPort, process.pid, false, true, {
      appName: "myapp",
      localUrl: "https://myapp.localhost",
      gatewayUrl: "https://delta-bare.tail6624e2.ts.net",
    });

    gateway = createGatewayServer({ store });
    const gatewayPort = await listen(gateway);

    const selection = await request(gatewayPort, `/myapp/${backendPort}`);
    const cookie = selection.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";

    const module = await request(gatewayPort, "/index.html?html-proxy&index=0.js", {
      Cookie: cookie,
    });
    expect(module.status).toBe(200);
    expect(module.headers["content-type"]).toBe("text/javascript");
    expect(module.body).toBe("module:/index.html?html-proxy&index=0.js");
  });
});
