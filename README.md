# xcodecloud-mcp

A focused Node.js MCP server for Xcode Cloud and App Store/TestFlight version discovery through the App Store Connect API.

## Setup

```sh
npm install
npm run build
```

Create a `.env` or pass environment variables from your MCP client. Local `.env` files are loaded automatically:

```sh
APP_STORE_CONNECT_ISSUER_ID=...
APP_STORE_CONNECT_KEY_ID=...
APP_STORE_CONNECT_PRIVATE_KEY_PATH=/absolute/path/AuthKey_ABC123.p8
```

Do not commit real App Store Connect credentials, bearer tokens, or `.p8` private keys. This repo ignores `.env`, `.env.*`, and `AuthKey_*.p8` files by default. Keep production secrets in your local environment or deployment secret store.

## Run

STDIO mode:

```sh
npm run start
```

HTTP mode:

```sh
npm run start:http
```

HTTP mode exposes:

```text
http://localhost:3000/mcp
```

Set `XCODECLOUD_MCP_BEARER_TOKEN` to require `Authorization: Bearer ...` for MCP requests.

## Logs

The server writes verbose JSON logs to `stderr` so MCP messages on `stdout` stay valid.

Set the minimum log level with:

```sh
XCODECLOUD_MCP_LOG_LEVEL=debug
```

Supported levels are `debug`, `info`, `warn`, and `error`. The default is `debug`.

On the first successful authenticated App Store Connect API response, the server logs:

```json
{"message":"app_store_connect_login_successful"}
```

Codex STDIO config example:

```json
{
  "mcpServers": {
    "xcodecloud": {
      "command": "node",
      "args": ["/absolute/path/to/xcodecloud-mcp/dist/index.js"],
      "env": {
        "APP_STORE_CONNECT_ISSUER_ID": "...",
        "APP_STORE_CONNECT_KEY_ID": "...",
        "APP_STORE_CONNECT_PRIVATE_KEY_PATH": "/absolute/path/AuthKey_ABC123.p8"
      }
    }
  }
}
```

Codex HTTP config example:

```toml
[mcp_servers.xcodecloud]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "XCODECLOUD_MCP_BEARER_TOKEN"
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 120
```

For HTTP mode, run the MCP server separately:

```sh
cd /Users/andreasehrlich-gruber/Documents/Repositories/xcodecloud-mcp
XCODECLOUD_MCP_TRANSPORT=http npm run start
```

The `XCODECLOUD_MCP_BEARER_TOKEN` value must be available in both places:

- the MCP server process, so it can verify incoming requests
- the Codex process, so Codex can send it as a bearer token

## Tools

- `list_apps`: list App Store Connect apps.
- `list_app_store_versions`: list App Store versions for an app.
- `list_testflight_versions`: list TestFlight pre-release versions for an app.
- `list_xcode_cloud_workflows`: list Xcode Cloud workflows for an app.
- `get_xcode_cloud_workflow`: fetch one Xcode Cloud workflow by id.
- `list_xcode_cloud_build_runs`: list Xcode Cloud build runs for a workflow.
- `get_xcode_cloud_build_run`: fetch one Xcode Cloud build run.
- `inspect_xcode_cloud_build`: get build status and failed action issues without downloading artifacts.
- `list_xcode_cloud_git_references`: list branch/tag references for a workflow repository.
- `start_xcode_cloud_build`: start an Xcode Cloud build run for a workflow.
- `start_xcode_cloud_build_for_branch`: start an Xcode Cloud build run by branch name.

## Postman

Import [postman/xcodecloud-mcp.postman_collection.json](postman/xcodecloud-mcp.postman_collection.json) into Postman to test HTTP mode.

Run requests in this order:

1. `Health / GET /healthz`
2. `MCP Session / 1. initialize`
3. `MCP Session / 2. initialized notification`
4. `MCP Session / 3. tools/list`
5. any request under `Tool Calls`

The initialize request stores the returned `mcp-session-id` header as a collection variable for follow-up MCP requests.

## Starting Xcode Cloud Builds

Use `list_apps` to discover the app id, then `list_xcode_cloud_workflows` to discover workflow ids, then call `start_xcode_cloud_build`.

Workflow discovery input:

```json
{
  "appId": "YOUR_APP_ID"
}
```

Minimal input:

```json
{
  "workflowId": "YOUR_WORKFLOW_ID"
}
```

Optional branch/tag override:

```json
{
  "workflowId": "YOUR_WORKFLOW_ID",
  "sourceBranchOrTagId": "SCM_GIT_REFERENCE_ID"
}
```

Branch-name shortcut:

```json
{
  "workflowId": "YOUR_WORKFLOW_ID",
  "branchName": "develop",
  "clean": true
}
```

`list_xcode_cloud_git_references` pages through App Store Connect's repository refs and returns `paging.hasMore`. For branch lookups, pass an exact `name`, `kind: "BRANCH"`, and keep `maxPages` at the default `20` unless you intentionally want a smaller scan.

To inspect a failed build without downloading logs or artifacts:

```json
{
  "buildRunId": "YOUR_BUILD_RUN_ID"
}
```

Use `inspect_xcode_cloud_build`; it reads build-run status, actions, and failed action issues only.
