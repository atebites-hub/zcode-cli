import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { resolveCodingPlanApiKey } from "../src/coding-plan-key.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(handler: (request: IncomingMessage, body: string) => {
  status?: number;
  body: unknown;
}): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      const result = handler(request, Buffer.concat(chunks).toString("utf8"));
      response.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("Coding Plan API key resolver", () => {
  test("finds or creates zcode-api-key from a desktop OAuth access token", async () => {
    const seen: string[] = [];
    const origin = await listen((request, body) => {
      seen.push(`${request.method} ${request.url}`);
      if (request.url === "/api/auth/z/login") {
        expect(JSON.parse(body)).toEqual({ token: "zai-access-token" });
        return { body: { code: 0, data: { access_token: "biz-token" } } };
      }
      if (request.url === "/api/biz/customer/getCustomerInfo") {
        expect(request.headers.authorization).toBe("Bearer biz-token");
        return {
          body: {
            code: 0,
            data: {
              userId: "user-1",
              organizations: [{
                organizationId: "org-1",
                organizationName: "默认机构",
                projects: [{ projectId: "proj-1", projectName: "默认项目" }]
              }]
            }
          }
        };
      }
      if (request.method === "GET" && request.url === "/api/biz/v1/organization/org-1/projects/proj-1/api_keys") {
        return { body: { code: 0, data: [{ name: "zcode-api-key", apiKey: "key-id" }] } };
      }
      if (request.url === "/api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/key-id") {
        return { body: { code: 0, data: { secretKey: "secret-material" } } };
      }
      return { status: 404, body: { code: 1, msg: `unexpected ${request.method} ${request.url}` } };
    });

    expect(await resolveCodingPlanApiKey("zai-access-token", { bizBaseURL: origin })).toBe("key-id.secret-material");
    expect(seen).toEqual([
      "POST /api/auth/z/login",
      "GET /api/biz/customer/getCustomerInfo",
      "GET /api/biz/v1/organization/org-1/projects/proj-1/api_keys",
      "GET /api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/key-id"
    ]);
  });

  test("creates zcode-api-key when the account has none", async () => {
    const origin = await listen((request, body) => {
      if (request.url === "/api/auth/z/login") {
        return { body: { code: 0, data: { accessToken: "biz-token" } } };
      }
      if (request.url === "/api/biz/customer/getCustomerInfo") {
        return {
          body: {
            code: 0,
            data: {
              organizations: [{
                organizationId: "org-2",
                organizationName: "Acme",
                projects: [{ projectId: "proj-2", projectName: "Work" }]
              }]
            }
          }
        };
      }
      if (request.method === "GET" && request.url?.endsWith("/api_keys")) {
        return { body: { code: 0, data: [] } };
      }
      if (request.method === "POST" && request.url?.endsWith("/api_keys")) {
        expect(JSON.parse(body)).toEqual({ name: "zcode-api-key" });
        return { body: { code: 0, data: { apiKey: "new-key" } } };
      }
      if (request.url?.endsWith("/copy/new-key")) {
        return { body: { code: 0, data: { secretKey: "new-secret" } } };
      }
      return { status: 404, body: { code: 1, msg: "unexpected" } };
    });

    expect(await resolveCodingPlanApiKey("token", { bizBaseURL: origin })).toBe("new-key.new-secret");
  });

  test("does not invent a key when business login fails", async () => {
    const origin = await listen(() => ({ body: { code: 1, msg: "captcha required" } }));
    await expect(resolveCodingPlanApiKey("token", { bizBaseURL: origin })).rejects.toThrow(/captcha required/);
  });
});
