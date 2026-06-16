#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppStoreConnectClient } from "./app-store-connect.js";
import { loadConfig } from "./config.js";
import { log, logError } from "./logger.js";

interface AppStoreConnectApi {
  get<T>(request: { path: string; query?: Record<string, unknown> }): Promise<T>;
  post<T>(request: { path: string; query?: Record<string, unknown>; body: unknown }): Promise<T>;
}

const config = (() => {
  try {
    const loaded = loadConfig();
    log("info", "configuration_loaded", {
      keyId: loaded.appStoreConnect.keyId,
      issuerId: loaded.appStoreConnect.issuerId,
      hasPrivateKey: loaded.appStoreConnect.privateKey.length > 0,
    });
    return loaded;
  } catch (error) {
    logError("configuration_failed", error);
    throw error;
  }
})();

type ToolResult = ReturnType<typeof jsonContent>;

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function withToolLogging<T extends ToolResult>(
  toolName: string,
  args: Record<string, unknown>,
  handler: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  log("info", "tool_call_started", { toolName, ...args });

  try {
    const result = await handler();
    log("info", "tool_call_completed", {
      toolName,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logError("tool_call_failed", error, {
      toolName,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export function createServer(appStoreConnect: AppStoreConnectApi = new AppStoreConnectClient(config.appStoreConnect)): McpServer {
  const server = new McpServer(
    {
      name: "xcodecloud-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "Use this MCP server for Xcode Cloud build runs and App Store/TestFlight version discovery. Prefer list_apps first to discover app ids, then list_xcode_cloud_workflows before starting a build. start_xcode_cloud_build creates a real Xcode Cloud build run.",
    },
  );

  server.registerTool(
    "list_apps",
    {
      description: "List App Store Connect apps visible to the configured API key. Use this to discover app ids.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20),
        bundleId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, bundleId }) => {
      return withToolLogging("list_apps", { limit, bundleId }, async () => {
        const response = await appStoreConnect.get({
          path: "/apps",
          query: {
            limit,
            "filter[bundleId]": bundleId,
            sort: "name",
          },
        });
        return jsonContent(response);
      });
    },
  );

  server.registerTool(
    "list_app_store_versions",
    {
      description: "List App Store versions for an app, including App Store version state. Results use App Store Connect default ordering.",
      inputSchema: {
        appId: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(20),
        platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).optional(),
        state: z.string().optional().describe("Optional App Store version state filter, such as READY_FOR_SALE."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit, platform, state }) => {
      return withToolLogging("list_app_store_versions", { appId, limit, platform, state }, async () => {
        const response = await appStoreConnect.get({
          path: `/apps/${encodeURIComponent(appId)}/appStoreVersions`,
          query: {
            limit,
            "filter[platform]": platform,
            "filter[appStoreState]": state,
            include: "build",
          },
        });
        return jsonContent(response);
      });
    },
  );

  server.registerTool(
    "list_testflight_versions",
    {
      description: "List TestFlight pre-release versions for an app.",
      inputSchema: {
        appId: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(20),
        platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit, platform }) => {
      return withToolLogging("list_testflight_versions", { appId, limit, platform }, async () => {
        const response = await appStoreConnect.get({
          path: "/preReleaseVersions",
          query: {
            limit,
            "filter[app]": appId,
            "filter[platform]": platform,
            sort: "-version",
            include: "app,builds",
          },
        });
        return jsonContent(response);
      });
    },
  );

  server.registerTool(
    "list_xcode_cloud_workflows",
    {
      description: "List Xcode Cloud workflows for an app. Uses the app's Xcode Cloud product relationship because ciWorkflows does not support collection listing.",
      inputSchema: {
        appId: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) => {
      return withToolLogging("list_xcode_cloud_workflows", { appId, limit }, async () => {
        const ciProductResponse = await appStoreConnect.get<{ data?: { id?: string } }>({
          path: `/apps/${encodeURIComponent(appId)}/ciProduct`,
        });

        const ciProductId = ciProductResponse.data?.id;
        if (!ciProductId) {
          return jsonContent(ciProductResponse);
        }

        const workflowsResponse = await appStoreConnect.get({
          path: `/ciProducts/${encodeURIComponent(ciProductId)}/workflows`,
          query: {
            limit,
          },
        });

        return jsonContent({
          ciProduct: ciProductResponse.data,
          workflows: workflowsResponse,
        });
      });
    },
  );

  server.registerTool(
    "get_xcode_cloud_workflow",
    {
      description: "Fetch one Xcode Cloud workflow by id.",
      inputSchema: {
        workflowId: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workflowId }) => {
      return withToolLogging("get_xcode_cloud_workflow", { workflowId }, async () => {
        const response = await appStoreConnect.get({
          path: `/ciWorkflows/${encodeURIComponent(workflowId)}`,
        });
        return jsonContent(response);
      });
    },
  );

  server.registerTool(
    "list_xcode_cloud_build_runs",
    {
      description: "List Xcode Cloud build runs for a workflow. Uses the workflow relationship because ciBuildRuns does not support collection listing.",
      inputSchema: {
        workflowId: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workflowId, limit }) => {
      return withToolLogging("list_xcode_cloud_build_runs", { workflowId, limit }, async () => {
        const response = await appStoreConnect.get({
          path: `/ciWorkflows/${encodeURIComponent(workflowId)}/buildRuns`,
          query: {
            limit,
          },
        });
        return jsonContent(response);
      });
    },
  );

  server.registerTool(
    "get_xcode_cloud_build_run",
    {
      description: "Fetch one Xcode Cloud build run by id.",
      inputSchema: {
        buildRunId: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ buildRunId }) => {
      return withToolLogging("get_xcode_cloud_build_run", { buildRunId }, async () => {
        const response = await appStoreConnect.get({
          path: `/ciBuildRuns/${encodeURIComponent(buildRunId)}`,
          query: {
            include: "workflow,builds",
          },
        });
        return jsonContent(response);
      });
    },
  );

  server.registerTool(
    "inspect_xcode_cloud_build",
    {
      description: "Get Xcode Cloud build status and, if failed, read action issues without downloading artifacts.",
      inputSchema: {
        buildRunId: z.string().min(1),
        includeSucceededActionIssues: z
          .boolean()
          .default(false)
          .describe("Also fetch issues for succeeded/skipped actions. Defaults to failed actions only."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ buildRunId, includeSucceededActionIssues }) => {
      return withToolLogging("inspect_xcode_cloud_build", { buildRunId, includeSucceededActionIssues }, async () => {
        const inspection = await inspectBuildRun(appStoreConnect, buildRunId, includeSucceededActionIssues);
        return jsonContent(inspection);
      });
    },
  );

  server.registerTool(
    "list_xcode_cloud_git_references",
    {
      description: "List git references for an Xcode Cloud workflow repository. Use this to find branch or tag ids such as develop.",
      inputSchema: {
        workflowId: z.string().min(1),
        name: z.string().optional().describe("Optional exact branch or tag name to filter locally, such as develop."),
        kind: z.enum(["BRANCH", "TAG"]).optional().describe("Optional local kind filter."),
        limit: z.number().int().min(1).max(200).default(200),
        maxPages: z.number().int().min(1).max(20).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workflowId, name, kind, limit, maxPages }) => {
      return withToolLogging("list_xcode_cloud_git_references", { workflowId, name, kind, limit, maxPages }, async () => {
        const repository = await appStoreConnect.get<{ data?: { id?: string } }>({
          path: `/ciWorkflows/${encodeURIComponent(workflowId)}/repository`,
        });

        const repositoryId = repository.data?.id;
        if (!repositoryId) {
          return jsonContent({ repository: repository.data, references: [] });
        }

        const gitReferences = await listGitReferences(appStoreConnect, repositoryId, limit, maxPages);
        const filteredReferences = gitReferences.references.filter((reference) => {
          const attributes = reference.attributes ?? {};
          if (name && attributes.name !== name && attributes.canonicalName !== `refs/heads/${name}` && attributes.canonicalName !== `refs/tags/${name}`) {
            return false;
          }
          if (kind && attributes.kind !== kind) {
            return false;
          }
          return true;
        });

        return jsonContent({
          repository: repository.data,
          references: filteredReferences,
          paging: {
            pagesRead: gitReferences.pagesRead,
            totalReferencesRead: gitReferences.references.length,
            hasMore: gitReferences.hasMore,
            maxPages,
            limit,
          },
        });
      });
    },
  );

  server.registerTool(
    "start_xcode_cloud_build",
    {
      description: "Start an Xcode Cloud build run for a workflow.",
      inputSchema: {
        workflowId: z.string().min(1),
        sourceBranchOrTagId: z
          .string()
          .optional()
          .describe("Optional App Store Connect scmGitReferences id for the branch or tag to build."),
        clean: z.boolean().optional().describe("Optional clean build flag when supported by the workflow/API."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workflowId, sourceBranchOrTagId, clean }) => {
      return withToolLogging("start_xcode_cloud_build", { workflowId, sourceBranchOrTagId, clean }, async () => {
        const relationships: Record<string, unknown> = {
          workflow: {
            data: {
              type: "ciWorkflows",
              id: workflowId,
            },
          },
        };

        if (sourceBranchOrTagId) {
          relationships.sourceBranchOrTag = {
            data: {
              type: "scmGitReferences",
              id: sourceBranchOrTagId,
            },
          };
        }

        const attributes = clean === undefined ? undefined : { clean };

        const response = await appStoreConnect.post({
          path: "/ciBuildRuns",
          body: {
            data: {
              type: "ciBuildRuns",
              ...(attributes ? { attributes } : {}),
              relationships,
            },
          },
        });

        return jsonContent(response);
      });
    },
  );

  server.registerTool(
    "start_xcode_cloud_build_for_branch",
    {
      description: "Start an Xcode Cloud build run for a workflow by branch name, resolving the scmGitReferences id automatically.",
      inputSchema: {
        workflowId: z.string().min(1),
        branchName: z.string().min(1).describe("Exact branch name, such as develop."),
        clean: z.boolean().optional().describe("Optional clean build flag when supported by the workflow/API."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workflowId, branchName, clean }) => {
      return withToolLogging("start_xcode_cloud_build_for_branch", { workflowId, branchName, clean }, async () => {
        const repository = await appStoreConnect.get<{ data?: { id?: string } }>({
          path: `/ciWorkflows/${encodeURIComponent(workflowId)}/repository`,
        });

        const repositoryId = repository.data?.id;
        if (!repositoryId) {
          throw new Error(`No repository found for workflow ${workflowId}.`);
        }

        const gitReferences = await listGitReferences(appStoreConnect, repositoryId, 200, 20);
        const branch = gitReferences.references.find((reference) => {
          const attributes = reference.attributes ?? {};
          return attributes.kind === "BRANCH" && !attributes.isDeleted && attributes.name === branchName;
        });

        if (!branch) {
          throw new Error(`Branch '${branchName}' was not found for workflow ${workflowId}.`);
        }

        const response = await startBuildRun(appStoreConnect, workflowId, branch.id, clean);
        return jsonContent({
          branch,
          buildRun: response,
        });
      });
    },
  );

  return server;
}

type GitReference = {
  id: string;
  type?: string;
  attributes?: {
    name?: string;
    kind?: "BRANCH" | "TAG" | string;
    canonicalName?: string;
    isDeleted?: boolean;
  };
};

type BuildRunResponse = {
  data?: {
    id: string;
    type?: string;
    attributes?: Record<string, unknown> & {
      number?: number;
      executionProgress?: string;
      completionStatus?: string | null;
      issueCounts?: unknown;
      createdDate?: string;
      startedDate?: string | null;
      finishedDate?: string | null;
      sourceCommit?: unknown;
    };
  };
  included?: Array<{
    id: string;
    type?: string;
    attributes?: Record<string, unknown>;
  }>;
};

type BuildAction = {
  id: string;
  type?: string;
  attributes?: Record<string, unknown> & {
    name?: string;
    actionType?: string;
    executionProgress?: string;
    completionStatus?: string | null;
    issueCounts?: unknown;
    startedDate?: string | null;
    finishedDate?: string | null;
  };
};

type Issue = {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
};

async function inspectBuildRun(
  appStoreConnect: AppStoreConnectApi,
  buildRunId: string,
  includeSucceededActionIssues: boolean,
): Promise<unknown> {
  const buildRun = await appStoreConnect.get<BuildRunResponse>({
    path: `/ciBuildRuns/${encodeURIComponent(buildRunId)}`,
    query: { include: "workflow,builds" },
  });

  const actionsResponse = await appStoreConnect.get<{ data?: BuildAction[] }>({
    path: `/ciBuildRuns/${encodeURIComponent(buildRunId)}/actions`,
    query: { limit: 200 },
  });

  const actions = [];
  const issues = [];

  for (const action of actionsResponse.data ?? []) {
    const attributes = action.attributes ?? {};
    const shouldFetchIssues =
      includeSucceededActionIssues ||
      attributes.completionStatus === "FAILED" ||
      attributes.completionStatus === "ERROR" ||
      attributes.executionProgress === "FAILED";

    let actionIssues: Issue[] = [];
    let issuesError: string | undefined;

    if (shouldFetchIssues) {
      try {
        const issuesResponse = await appStoreConnect.get<{ data?: Issue[] }>({
          path: `/ciBuildActions/${encodeURIComponent(action.id)}/issues`,
          query: { limit: 200 },
        });
        actionIssues = issuesResponse.data ?? [];
        issues.push(
          ...actionIssues.map((issue) => ({
            actionId: action.id,
            actionName: attributes.name,
            actionType: attributes.actionType,
            id: issue.id,
            type: issue.type,
            attributes: issue.attributes,
          })),
        );
      } catch (error) {
        issuesError = error instanceof Error ? error.message : String(error);
      }
    }

    actions.push({
      id: action.id,
      type: action.type,
      name: attributes.name,
      actionType: attributes.actionType,
      executionProgress: attributes.executionProgress,
      completionStatus: attributes.completionStatus,
      issueCounts: attributes.issueCounts,
      startedDate: attributes.startedDate,
      finishedDate: attributes.finishedDate,
      issuesFetched: shouldFetchIssues,
      issueCount: actionIssues.length,
      issuesError,
    });
  }

  return {
    buildRun: {
      id: buildRun.data?.id,
      type: buildRun.data?.type,
      number: buildRun.data?.attributes?.number,
      executionProgress: buildRun.data?.attributes?.executionProgress,
      completionStatus: buildRun.data?.attributes?.completionStatus,
      issueCounts: buildRun.data?.attributes?.issueCounts,
      createdDate: buildRun.data?.attributes?.createdDate,
      startedDate: buildRun.data?.attributes?.startedDate,
      finishedDate: buildRun.data?.attributes?.finishedDate,
      sourceCommit: buildRun.data?.attributes?.sourceCommit,
    },
    included: buildRun.included ?? [],
    actions,
    issues,
    artifactsDownloaded: false,
  };
}

async function listGitReferences(
  appStoreConnect: AppStoreConnectApi,
  repositoryId: string,
  limit: number,
  maxPages: number,
): Promise<{ references: GitReference[]; pagesRead: number; hasMore: boolean }> {
  const references: GitReference[] = [];
  let path: string = `/scmRepositories/${encodeURIComponent(repositoryId)}/gitReferences`;
  let query: Record<string, unknown> | undefined = { limit };
  let pagesRead = 0;
  let hasMore = false;

  for (let page = 0; page < maxPages; page += 1) {
    pagesRead = page + 1;
    const response: { data?: GitReference[]; links?: { next?: string } } = await appStoreConnect.get({ path, query });
    references.push(...(response.data ?? []));

    hasMore = Boolean(response.links?.next);
    if (!response.links?.next) break;
    const next: URL = new URL(response.links.next);
    path = next.pathname.replace(/^\/v1/, "");
    query = Object.fromEntries(next.searchParams.entries());
  }

  return { references, pagesRead, hasMore };
}

async function startBuildRun(
  appStoreConnect: AppStoreConnectApi,
  workflowId: string,
  sourceBranchOrTagId: string,
  clean?: boolean,
): Promise<unknown> {
  const attributes = clean === undefined ? undefined : { clean };

  return appStoreConnect.post({
    path: "/ciBuildRuns",
    body: {
      data: {
        type: "ciBuildRuns",
        ...(attributes ? { attributes } : {}),
        relationships: {
          workflow: {
            data: {
              type: "ciWorkflows",
              id: workflowId,
            },
          },
          sourceBranchOrTag: {
            data: {
              type: "scmGitReferences",
              id: sourceBranchOrTagId,
            },
          },
        },
      },
    },
  });
}

function isAuthorized(authorizationHeader: unknown): boolean {
  const expectedToken = process.env.XCODECLOUD_MCP_BEARER_TOKEN ?? process.env.TESTFLIGHT_MCP_BEARER_TOKEN;
  if (!expectedToken) return true;
  if (typeof authorizationHeader !== "string") return false;

  const [scheme, token] = authorizationHeader.split(" ");
  return scheme?.toLowerCase() === "bearer" && token === expectedToken;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  log("info", "mcp_server_starting", {
    transport: "stdio",
    logLevel: process.env.XCODECLOUD_MCP_LOG_LEVEL ?? process.env.TESTFLIGHT_MCP_LOG_LEVEL ?? "debug",
  });
  await server.connect(transport);
  log("info", "mcp_server_connected", { transport: "stdio" });
}

export async function startHttpServer(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? process.env.XCODECLOUD_MCP_PORT ?? process.env.TESTFLIGHT_MCP_PORT ?? "9932", 10);
  const endpoint = process.env.XCODECLOUD_MCP_ENDPOINT ?? process.env.TESTFLIGHT_MCP_ENDPOINT ?? "/mcp";
  const app = createMcpExpressApp();
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const handleMcpRequest = async (req: any, res: any): Promise<void> => {
    if (!isAuthorized(req.headers.authorization)) {
      log("warn", "http_request_unauthorized", {
        method: req.method,
        path: req.path,
      });
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    try {
      let transport: StreamableHTTPServerTransport;

      if (typeof sessionId === "string" && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            transports[initializedSessionId] = transport;
            log("info", "http_mcp_session_initialized", { sessionId: initializedSessionId });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) {
            delete transports[closedSessionId];
            log("info", "http_mcp_session_closed", { sessionId: closedSessionId });
          }
        };

        await createServer().connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: no valid MCP session id or initialize request",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logError("http_mcp_request_failed", error, {
        method: req.method,
        path: req.path,
        sessionId,
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  };

  app.post(endpoint, handleMcpRequest);
  app.get(endpoint, handleMcpRequest);
  app.delete(endpoint, handleMcpRequest);

  app.get("/healthz", (_req: any, res: any) => {
    res.status(200).json({ ok: true, service: "xcodecloud-mcp" });
  });

  app.listen(port, (error?: Error) => {
    if (error) {
      logError("http_mcp_server_failed_to_start", error, { port, endpoint });
      process.exit(1);
    }
    log("info", "http_mcp_server_listening", {
      port,
      endpoint,
      authEnabled: Boolean(process.env.XCODECLOUD_MCP_BEARER_TOKEN ?? process.env.TESTFLIGHT_MCP_BEARER_TOKEN),
      logLevel: process.env.XCODECLOUD_MCP_LOG_LEVEL ?? process.env.TESTFLIGHT_MCP_LOG_LEVEL ?? "debug",
    });
  });
}

const transportMode =
  process.argv.includes("--http") ||
  process.env.XCODECLOUD_MCP_TRANSPORT === "http" ||
  process.env.TESTFLIGHT_MCP_TRANSPORT === "http"
    ? "http"
    : "stdio";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (transportMode === "http") {
    await startHttpServer();
  } else {
    await startStdioServer();
  }
}
