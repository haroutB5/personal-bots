# Self-Hosted Executor (External MCP Server)

This helper runs [Executor](https://github.com/usefulsoftwareco/executor) locally on loopback so personal bots can call its Streamable HTTP MCP endpoint through hbots's sensitive-site-guarded reverse proxy.

## Security Defaults

- Bound strictly to `127.0.0.1:4400` (not exposed on LAN or Tailscale).
- Runs with `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=false` so Executor apps cannot fetch private/internal network addresses.
- Persists state in the `executor-v2-data` Docker volume.
- Register the server in hbots Settings -> External MCP Servers with:
  - Slug: `executor`
  - URL: `http://127.0.0.1:4400/mcp`
  - Bearer token: your Executor API token (stored AES-256-GCM encrypted in `ServerSecretStore`, injected server-side by the hbots proxy and never passed into provider processes).

## Usage

```bash
chmod +x scripts/personal/linux/executor/executor-docker.sh

# Start (creates the executor-v2-data volume on first run)
./scripts/personal/linux/executor/executor-docker.sh start

# Check container status
./scripts/personal/linux/executor/executor-docker.sh status

# Tail logs
./scripts/personal/linux/executor/executor-docker.sh logs

# Stop (preserves the container and executor-v2-data volume)
./scripts/personal/linux/executor/executor-docker.sh stop
```

## Kill Switch

Set `T3CODE_PERSONAL_EXTERNAL_MCP=off` in the hbots server environment to disable both provider session injection and proxy forwarding (returns HTTP 503).
