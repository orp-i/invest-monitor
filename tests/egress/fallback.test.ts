import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "undici";
import type { EgressName, EgressProfile } from "@invest/config";
import { EgressDispatcherPool, EgressHttpClient, type EgressFallbackEvent } from "@invest/egress";

vi.mock("undici", async (importOriginal) => {
  const original = await importOriginal<typeof import("undici")>();
  return { ...original, request: vi.fn() };
});

const requestMock = vi.mocked(request);
const openClients: EgressHttpClient[] = [];

afterEach(async () => {
  requestMock.mockReset();
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("per-request egress fallback", () => {
  it("falls back in order after a connection-layer failure", async () => {
    requestMock
      .mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
      .mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }))
      .mockResolvedValueOnce(rawResponse(200, "ok"));
    const fallbackEvents: EgressFallbackEvent[] = [];
    const client = createClient((event) => fallbackEvents.push(event));

    const options = requestOptions("https://provider.test/price", "vpn", ["corp", "direct"]);
    const response = await client.request(options);

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value.status).toBe(200);
    expect(response.value.egressProfileUsed).toBe("direct");
    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(fallbackEvents).toHaveLength(2);
    expect(fallbackEvents[0]).toMatchObject({
      primary: "vpn",
      failedProfile: "vpn",
      fallbackProfile: "corp",
      error: { code: "ECONNREFUSED", fallbackEligible: true },
    });
    expect(fallbackEvents[1]).toMatchObject({
      primary: "vpn",
      failedProfile: "corp",
      fallbackProfile: "direct",
      error: { code: "ENOTFOUND", fallbackEligible: true },
    });

    requestMock.mockResolvedValueOnce(rawResponse(200, "primary recovered"));
    const recovered = await client.request(options);
    expect(recovered.ok && recovered.value.egressProfileUsed).toBe("vpn");
    expect(requestMock).toHaveBeenCalledTimes(4);
    expect(fallbackEvents).toHaveLength(2);
  });

  it("returns HTTP 401 from the primary without trying a fallback", async () => {
    requestMock.mockResolvedValueOnce(rawResponse(401, "missing key"));
    const fallbackEvents: EgressFallbackEvent[] = [];
    const client = createClient((event) => fallbackEvents.push(event));

    const response = await client.request(requestOptions("https://provider.test/v1/protected", "direct", ["corp"]));

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value.status).toBe(401);
    expect(response.value.egressProfileUsed).toBe("direct");
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(fallbackEvents).toEqual([]);
  });

  it("does not fall back after a 401 status even if reading its body fails", async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 401,
      headers: {},
      body: {
        arrayBuffer: async () => {
          throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        },
      },
    } as Awaited<ReturnType<typeof request>>);
    const fallbackEvents: EgressFallbackEvent[] = [];
    const client = createClient((event) => fallbackEvents.push(event));

    const response = await client.request(requestOptions("https://provider.test/v1/protected", "direct", ["corp"]));

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error).toMatchObject({ code: "ECONNRESET", fallbackEligible: false, egressProfileUsed: "direct" });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(fallbackEvents).toEqual([]);
  });
});

function createClient(onFallback: (event: EgressFallbackEvent) => void): EgressHttpClient {
  const profiles: Record<EgressName, EgressProfile> = {
    direct: profile("direct"),
    corp: profile("corp"),
    vpn: profile("vpn"),
  };
  const client = new EgressHttpClient(new EgressDispatcherPool(profiles), onFallback);
  openClients.push(client);
  return client;
}

function profile(name: EgressName): EgressProfile {
  return {
    name,
    proxyUrl: null,
    userAgent: "egress-test/1.0",
    followRedirects: false,
    maxRedirects: 0,
    connectTimeoutMs: 200,
    requestTimeoutMs: 2_000,
  };
}

function requestOptions(url: string, egressProfile: EgressName, egressFallback: readonly EgressName[]) {
  return {
    url,
    egressProfile,
    egressFallback,
    userAgent: "egress-test/1.0",
    followRedirects: false,
    maxRedirects: 0,
    connectTimeoutMs: 200,
    requestTimeoutMs: 2_000,
  } as const;
}

function rawResponse(statusCode: number, body: string) {
  const bytes = new TextEncoder().encode(body);
  return {
    statusCode,
    headers: {},
    body: { arrayBuffer: async () => bytes.buffer },
  } as Awaited<ReturnType<typeof request>>;
}
