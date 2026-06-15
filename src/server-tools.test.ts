import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_STORE_CONNECT_ISSUER_ID = "issuer-id";
process.env.APP_STORE_CONNECT_KEY_ID = "key-id";
process.env.APP_STORE_CONNECT_PRIVATE_KEY = "unused-in-tests";
process.env.XCODECLOUD_MCP_LOG_LEVEL = "error";

type AscCall = {
  method: "get" | "post";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
};

class FakeAppStoreConnectClient {
  calls: AscCall[] = [];

  async get<T>(request: { path: string; query?: Record<string, unknown> }): Promise<T> {
    this.calls.push({ method: "get", ...request });

    if (request.path === "/apps") {
      return {
        data: [
          {
            id: "stepsapp-app-id",
            type: "apps",
            attributes: {
              name: "StepsApp Pedometer",
              bundleId: "com.stepsapp.pedometer",
            },
          },
        ],
      } as T;
    }

    if (request.path === "/apps/stepsapp-app-id/appStoreVersions") {
      return {
        data: [
          {
            id: "version-1",
            type: "appStoreVersions",
            attributes: {
              versionString: "8.0.0",
              appStoreState: "READY_FOR_SALE",
            },
          },
        ],
      } as T;
    }

    if (request.path === "/apps/stepsapp-app-id/ciProduct") {
      return { data: { id: "ci-product-1", type: "ciProducts" } } as T;
    }

    if (request.path === "/ciProducts/ci-product-1/workflows") {
      return {
        data: [
          {
            id: "workflow-1",
            type: "ciWorkflows",
            attributes: { name: "StepsApp Pedometer Release" },
          },
        ],
      } as T;
    }

    if (request.path === "/ciWorkflows/workflow-1/buildRuns") {
      return {
        data: [
          {
            id: "build-run-1",
            type: "ciBuildRuns",
            attributes: { completionStatus: "SUCCEEDED" },
          },
        ],
      } as T;
    }

    if (request.path === "/ciWorkflows/workflow-1/repository") {
      return {
        data: {
          id: "repository-1",
          type: "scmRepositories",
          attributes: {
            repositoryName: "stepsapp-iOS",
            ownerName: "stepsapp",
          },
        },
      } as T;
    }

    if (request.path === "/scmRepositories/repository-1/gitReferences") {
      return {
        data: [
          {
            id: "develop-ref",
            type: "scmGitReferences",
            attributes: {
              name: "develop",
              kind: "BRANCH",
              canonicalName: "refs/heads/develop",
              isDeleted: false,
            },
          },
          {
            id: "version-ref",
            type: "scmGitReferences",
            attributes: {
              name: "version-1",
              kind: "TAG",
              canonicalName: "refs/tags/version-1",
              isDeleted: false,
            },
          },
        ],
      } as T;
    }

    if (request.path === "/ciBuildRuns/build-run-1") {
      return {
        data: {
          id: "build-run-1",
          type: "ciBuildRuns",
          attributes: {
            number: 2634,
            executionProgress: "COMPLETE",
            completionStatus: "FAILED",
            sourceCommit: {
              commitSha: "abc123",
              message: "Break build",
              webUrl: "https://github.example/commit/abc123",
            },
          },
        },
      } as T;
    }

    if (request.path === "/ciBuildRuns/build-run-1/actions") {
      return {
        data: [
          {
            id: "failed-action-1",
            type: "ciBuildActions",
            attributes: {
              name: "Archive - iOS",
              actionType: "ARCHIVE",
              executionProgress: "COMPLETE",
              completionStatus: "FAILED",
              issueCounts: null,
            },
          },
          {
            id: "skipped-action-1",
            type: "ciBuildActions",
            attributes: {
              name: "TestFlight Internal Testing - iOS",
              actionType: "TEST",
              executionProgress: "COMPLETE",
              completionStatus: "SKIPPED",
              issueCounts: null,
            },
          },
        ],
      } as T;
    }

    if (request.path === "/ciBuildActions/failed-action-1/issues") {
      return {
        data: [
          {
            id: "issue-1",
            type: "ciIssues",
            attributes: {
              issueType: "ERROR",
              fileSource: {
                path: "file:///Volumes/workspace/repository/stepapp/Classes/ViewController/Main/TabBarViewController+Startup.swift",
                lineNumber: 254,
              },
              message: "Modifier Order Violation: dynamic modifier should come before required (modifier_order)",
              category: "Xcodebuild",
            },
          },
        ],
      } as T;
    }

    throw new Error(`Unexpected GET ${request.path}`);
  }

  async post<T>(request: { path: string; query?: Record<string, unknown>; body: unknown }): Promise<T> {
    this.calls.push({ method: "post", ...request });

    if (request.path === "/ciBuildRuns") {
      return {
        data: {
          id: "started-build-run-1",
          type: "ciBuildRuns",
          attributes: { executionProgress: "PENDING" },
        },
      } as T;
    }

    throw new Error(`Unexpected POST ${request.path}`);
  }
}

let createServer: typeof import("./index.js").createServer;

beforeAll(async () => {
  ({ createServer } = await import("./index.js"));
});

async function connectTestClient(fakeAsc: FakeAppStoreConnectClient) {
  const server = createServer(fakeAsc);
  const client = new Client({ name: "vitest-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function parseTextResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = "content" in result ? (result.content as Array<{ type: string; text?: string }>) : undefined;
  if (!content || content[0]?.type !== "text" || !content[0].text) {
    throw new Error("Expected text tool result");
  }
  return JSON.parse(content[0].text);
}

describe("MCP tools", () => {
  let activeClient: { close(): Promise<void> } | undefined;

  afterEach(async () => {
    await activeClient?.close();
    activeClient = undefined;
  });

  it("exposes the expected Xcode Cloud and version tools", async () => {
    const fakeAsc = new FakeAppStoreConnectClient();
    const { client, close } = await connectTestClient(fakeAsc);
    activeClient = { close };

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_xcode_cloud_build_run",
      "get_xcode_cloud_workflow",
      "inspect_xcode_cloud_build",
      "list_app_store_versions",
      "list_apps",
      "list_testflight_versions",
      "list_xcode_cloud_build_runs",
      "list_xcode_cloud_git_references",
      "list_xcode_cloud_workflows",
      "start_xcode_cloud_build",
      "start_xcode_cloud_build_for_branch",
    ]);
  });

  it("discovers StepsApp Pedometer by bundle id without requiring Xcode Cloud ids up front", async () => {
    const fakeAsc = new FakeAppStoreConnectClient();
    const { client, close } = await connectTestClient(fakeAsc);
    activeClient = { close };

    const result = parseTextResult(
      await client.callTool({
        name: "list_apps",
        arguments: {
          bundleId: "com.stepsapp.pedometer",
          limit: 20,
        },
      }),
    );

    expect(result.data[0].attributes.name).toBe("StepsApp Pedometer");
    expect(fakeAsc.calls[0]).toMatchObject({
      method: "get",
      path: "/apps",
      query: {
        "filter[bundleId]": "com.stepsapp.pedometer",
        limit: 20,
        sort: "name",
      },
    });
  });

  it("lists App Store version state without unsupported sort parameters", async () => {
    const fakeAsc = new FakeAppStoreConnectClient();
    const { client, close } = await connectTestClient(fakeAsc);
    activeClient = { close };

    const result = parseTextResult(
      await client.callTool({
        name: "list_app_store_versions",
        arguments: {
          appId: "stepsapp-app-id",
          limit: 10,
        },
      }),
    );

    expect(result.data[0].attributes.appStoreState).toBe("READY_FOR_SALE");
    expect(fakeAsc.calls[0]).toMatchObject({
      method: "get",
      path: "/apps/stepsapp-app-id/appStoreVersions",
      query: {
        include: "build",
        limit: 10,
      },
    });
    expect(fakeAsc.calls[0]?.query).not.toHaveProperty("sort");
  });

  it("lists workflows through the app ciProduct relationship", async () => {
    const fakeAsc = new FakeAppStoreConnectClient();
    const { client, close } = await connectTestClient(fakeAsc);
    activeClient = { close };

    const result = parseTextResult(
      await client.callTool({
        name: "list_xcode_cloud_workflows",
        arguments: {
          appId: "stepsapp-app-id",
          limit: 50,
        },
      }),
    );

    expect(result.workflows.data[0].attributes.name).toBe("StepsApp Pedometer Release");
    expect(fakeAsc.calls).toEqual([
      {
        method: "get",
        path: "/apps/stepsapp-app-id/ciProduct",
      },
      {
        method: "get",
        path: "/ciProducts/ci-product-1/workflows",
        query: { limit: 50 },
      },
    ]);
  });

  it("lists build runs through the workflow relationship", async () => {
    const fakeAsc = new FakeAppStoreConnectClient();
    const { client, close } = await connectTestClient(fakeAsc);
    activeClient = { close };

    const result = parseTextResult(
      await client.callTool({
        name: "list_xcode_cloud_build_runs",
        arguments: {
          workflowId: "workflow-1",
          limit: 20,
        },
      }),
    );

    expect(result.data[0].id).toBe("build-run-1");
    expect(fakeAsc.calls[0]).toEqual({
      method: "get",
      path: "/ciWorkflows/workflow-1/buildRuns",
      query: { limit: 20 },
    });
  });

  it("starts an Xcode Cloud build run with the expected relationship body", async () => {
    const fakeAsc = new FakeAppStoreConnectClient();
    const { client, close } = await connectTestClient(fakeAsc);
    activeClient = { close };

    const result = parseTextResult(
      await client.callTool({
        name: "start_xcode_cloud_build",
        arguments: {
          workflowId: "workflow-1",
          sourceBranchOrTagId: "main-ref",
          clean: true,
        },
      }),
    );

    expect(result.data.id).toBe("started-build-run-1");
    expect(fakeAsc.calls[0]).toEqual({
      method: "post",
      path: "/ciBuildRuns",
      body: {
        data: {
          type: "ciBuildRuns",
          attributes: { clean: true },
          relationships: {
            workflow: {
              data: {
                type: "ciWorkflows",
                id: "workflow-1",
              },
            },
            sourceBranchOrTag: {
              data: {
                type: "scmGitReferences",
                id: "main-ref",
              },
            },
          },
        },
      },
    });
  });

  it("lists git references for a workflow repository and filters to the develop branch", async () => {
    const fakeAsc = new FakeAppStoreConnectClient();
    const { client, close } = await connectTestClient(fakeAsc);
    activeClient = { close };

    const result = parseTextResult(
      await client.callTool({
        name: "list_xcode_cloud_git_references",
        arguments: {
          workflowId: "workflow-1",
          name: "develop",
          kind: "BRANCH",
        },
      }),
    );

    expect(result.references).toEqual([
      {
        id: "develop-ref",
        type: "scmGitReferences",
        attributes: {
          name: "develop",
          kind: "BRANCH",
          canonicalName: "refs/heads/develop",
          isDeleted: false,
        },
      },
    ]);
    expect(result.paging).toEqual({
      pagesRead: 1,
      totalReferencesRead: 2,
      hasMore: false,
      maxPages: 20,
      limit: 200,
    });
    expect(fakeAsc.calls).toEqual([
      {
        method: "get",
        path: "/ciWorkflows/workflow-1/repository",
      },
      {
        method: "get",
        path: "/scmRepositories/repository-1/gitReferences",
        query: { limit: 200 },
      },
    ]);
  });

  it("starts an Xcode Cloud build run by branch name", async () => {
    const fakeAsc = new FakeAppStoreConnectClient();
    const { client, close } = await connectTestClient(fakeAsc);
    activeClient = { close };

    const result = parseTextResult(
      await client.callTool({
        name: "start_xcode_cloud_build_for_branch",
        arguments: {
          workflowId: "workflow-1",
          branchName: "develop",
          clean: true,
        },
      }),
    );

    expect(result.branch.id).toBe("develop-ref");
    expect(result.buildRun.data.id).toBe("started-build-run-1");
    expect(fakeAsc.calls.at(-1)).toEqual({
      method: "post",
      path: "/ciBuildRuns",
      body: {
        data: {
          type: "ciBuildRuns",
          attributes: { clean: true },
          relationships: {
            workflow: {
              data: {
                type: "ciWorkflows",
                id: "workflow-1",
              },
            },
            sourceBranchOrTag: {
              data: {
                type: "scmGitReferences",
                id: "develop-ref",
              },
            },
          },
        },
      },
    });
  });

  it("inspects a failed Xcode Cloud build without downloading artifacts", async () => {
    const fakeAsc = new FakeAppStoreConnectClient();
    const { client, close } = await connectTestClient(fakeAsc);
    activeClient = { close };

    const result = parseTextResult(
      await client.callTool({
        name: "inspect_xcode_cloud_build",
        arguments: {
          buildRunId: "build-run-1",
        },
      }),
    );

    expect(result.buildRun).toMatchObject({
      id: "build-run-1",
      number: 2634,
      executionProgress: "COMPLETE",
      completionStatus: "FAILED",
    });
    expect(result.actions).toEqual([
      {
        id: "failed-action-1",
        type: "ciBuildActions",
        name: "Archive - iOS",
        actionType: "ARCHIVE",
        executionProgress: "COMPLETE",
        completionStatus: "FAILED",
        issueCounts: null,
        issuesFetched: true,
        issueCount: 1,
      },
      {
        id: "skipped-action-1",
        type: "ciBuildActions",
        name: "TestFlight Internal Testing - iOS",
        actionType: "TEST",
        executionProgress: "COMPLETE",
        completionStatus: "SKIPPED",
        issueCounts: null,
        issuesFetched: false,
        issueCount: 0,
      },
    ]);
    expect(result.issues).toEqual([
      {
        actionId: "failed-action-1",
        actionName: "Archive - iOS",
        actionType: "ARCHIVE",
        id: "issue-1",
        type: "ciIssues",
        attributes: {
          issueType: "ERROR",
          fileSource: {
            path: "file:///Volumes/workspace/repository/stepapp/Classes/ViewController/Main/TabBarViewController+Startup.swift",
            lineNumber: 254,
          },
          message: "Modifier Order Violation: dynamic modifier should come before required (modifier_order)",
          category: "Xcodebuild",
        },
      },
    ]);
    expect(result.artifactsDownloaded).toBe(false);
    expect(fakeAsc.calls.map((call) => call.path)).toEqual([
      "/ciBuildRuns/build-run-1",
      "/ciBuildRuns/build-run-1/actions",
      "/ciBuildActions/failed-action-1/issues",
    ]);
  });
});
