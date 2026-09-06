const defaultBizBaseURL = "https://api.z.ai";
const codingPlanApiKeyName = "zcode-api-key";
const defaultOrganizationName = "默认机构";
const defaultProjectName = "默认项目";

export interface ResolveCodingPlanApiKeyOptions {
  bizBaseURL?: string;
  fetch?: typeof fetch;
}

interface Envelope {
  code?: unknown;
  data?: unknown;
  msg?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelopeSucceeded(code: unknown): boolean {
  if (code === undefined || code === null || code === 0 || code === 200) return true;
  return code === "0" || code === "200";
}

function envelopeError(operation: string, envelope: Envelope, status: number): Error {
  const message = envelope.msg?.trim()
    || (typeof envelope.code === "string" || typeof envelope.code === "number"
      ? `business error ${envelope.code}`
      : `HTTP ${status}`);
  return new Error(`z.ai ${operation} failed: ${message}`);
}

async function bizRequest(
  fetchImpl: typeof fetch,
  origin: string,
  method: "GET" | "POST",
  path: string,
  bearer: string | undefined,
  body: unknown,
  operation: string
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetchImpl(new URL(path, origin).toString(), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const envelope = await response.json() as Envelope;
  if (!envelopeSucceeded(envelope.code) || response.status < 200 || response.status >= 300) {
    throw envelopeError(operation, envelope, response.status);
  }
  return envelope.data;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export async function resolveCodingPlanApiKey(
  accessToken: string,
  options: ResolveCodingPlanApiKeyOptions = {}
): Promise<string> {
  const token = accessToken.trim();
  if (!token) throw new Error("z.ai access token is required");
  const origin = (options.bizBaseURL ?? defaultBizBaseURL).replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? fetch;

  const login = await bizRequest(fetchImpl, origin, "POST", "/api/auth/z/login", undefined, {
    token
  }, "business login");
  const bizToken = isRecord(login)
    ? firstString(login.access_token, login.accessToken)
    : undefined;
  if (!bizToken) throw new Error("z.ai business login response is missing access_token");

  const customer = await bizRequest(
    fetchImpl,
    origin,
    "GET",
    "/api/biz/customer/getCustomerInfo",
    bizToken,
    undefined,
    "customer info"
  );
  if (!isRecord(customer) || !Array.isArray(customer.organizations) || customer.organizations.length === 0) {
    throw new Error("z.ai account has no organization");
  }
  const organization = customer.organizations.find((entry) => (
    isRecord(entry) && typeof entry.organizationName === "string"
    && entry.organizationName.includes(defaultOrganizationName)
  )) ?? customer.organizations[0];
  if (!isRecord(organization) || !Array.isArray(organization.projects) || organization.projects.length === 0) {
    throw new Error("z.ai organization has no project");
  }
  const project = organization.projects.find((entry) => (
    isRecord(entry) && typeof entry.projectName === "string"
    && entry.projectName.includes(defaultProjectName)
  )) ?? organization.projects[0];
  if (!isRecord(project)) throw new Error("z.ai customer info is missing organization or project");
  const organizationId = firstString(organization.organizationId);
  const projectId = firstString(project.projectId);
  if (!organizationId || !projectId) {
    throw new Error("z.ai customer info is missing organization or project");
  }

  const keysPath = `/api/biz/v1/organization/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/api_keys`;
  const listed = await bizRequest(fetchImpl, origin, "GET", keysPath, bizToken, undefined, "API key list");
  let apiKeyId: string | undefined;
  if (Array.isArray(listed)) {
    for (const item of listed) {
      if (isRecord(item) && item.name === codingPlanApiKeyName) {
        apiKeyId = firstString(item.apiKey);
        if (apiKeyId) break;
      }
    }
  }
  if (!apiKeyId) {
    const created = await bizRequest(
      fetchImpl,
      origin,
      "POST",
      keysPath,
      bizToken,
      { name: codingPlanApiKeyName },
      "API key creation"
    );
    apiKeyId = isRecord(created) ? firstString(created.apiKey) : undefined;
  }
  if (!apiKeyId) throw new Error("z.ai API key response is missing apiKey");

  const copied = await bizRequest(
    fetchImpl,
    origin,
    "GET",
    `${keysPath}/copy/${encodeURIComponent(apiKeyId)}`,
    bizToken,
    undefined,
    "API key secret"
  );
  const secret = isRecord(copied) ? firstString(copied.secretKey) : undefined;
  if (!secret) throw new Error("z.ai API key secret response is missing secretKey");
  return `${apiKeyId}.${secret}`;
}
