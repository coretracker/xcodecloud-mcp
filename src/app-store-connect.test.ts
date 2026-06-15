import { describe, expect, it, vi } from "vitest";
import { AppStoreConnectClient } from "./app-store-connect.js";

const config = {
  issuerId: "issuer-id",
  keyId: "key-id",
  privateKey: "unused-in-tests",
};

describe("AppStoreConnectClient", () => {
  it("omits empty optional query parameters", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    const client = new AppStoreConnectClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      tokenProvider: async () => "test-token",
    });

    await client.get({
      path: "/apps",
      query: {
        limit: 20,
        "filter[bundleId]": "",
        "filter[name]": "StepsApp Pedometer",
        sort: "name",
      },
    });

    const [[url]] = fetchMock.mock.calls as unknown as Array<[URL, RequestInit | undefined]>;
    expect(url.pathname).toBe("/v1/apps");
    expect(url.searchParams.get("filter[bundleId]")).toBeNull();
    expect(url.searchParams.get("filter[name]")).toBe("StepsApp Pedometer");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("sort")).toBe("name");
  });

  it("sends POST JSON bodies with bearer authorization", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { id: "build-run-1" } }));
    const client = new AppStoreConnectClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      tokenProvider: async () => "test-token",
    });

    await client.post({
      path: "/ciBuildRuns",
      body: {
        data: {
          type: "ciBuildRuns",
          relationships: {
            workflow: {
              data: { type: "ciWorkflows", id: "workflow-1" },
            },
          },
        },
      },
    });

    const [[, init]] = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-token",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      data: {
        type: "ciBuildRuns",
        relationships: {
          workflow: {
            data: { type: "ciWorkflows", id: "workflow-1" },
          },
        },
      },
    });
  });
});
