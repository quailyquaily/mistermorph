# Demos: Embedding `mistermorph`

This folder contains three demos showing how to embed `mistermorph` into another project.

## Deployment options (pros/cons)

If you are choosing where to deploy `mistermorph`, use this quick comparison first, then open the target README for exact steps.

| Target | Pros | Cons | Best for |
|---|---|---|---|
| AWS Lightsail Containers | Fastest path to container rollout; simple shell-based deploy flow | AWS-specific; less flexible than full VM control | Telegram bot or small production setup on AWS |
| Cloudflare Worker + Container | Edge entrypoint; easy global ingress; Console UI and API | Extra moving parts (Worker + container + Wrangler); Cloudflare platform coupling | Public Console with R2 state backups |
| systemd on Linux VM | Full control over host, files, and networking; straightforward operations model | You manage OS patching/backup/monitoring yourself | Self-hosted VM/bare metal with existing ops practices |

Deployment docs:

- `deploy/README.md`
- `deploy/lightsail/README.md`
- `deploy/cloudflare/README.md`
- `deploy/systemd/README.md`

## 1) Embed as a Go library

See `demo/embed-go/`.

It now includes three runtime modes in one program:
- `task`: one-shot in-process task run
- `telegram`: start Telegram bot via integration API
- `slack`: start Slack Socket Mode bot via integration API

## 2) Embed as a CLI subprocess

See `demo/embed-cli/`.

## 3) Connect a Console to your program

See `demo/embed-console/`.

A Go program that serves the runtime API with `rt.ServeRuntimeAPI(...)`, so a Console can add it as an endpoint: chat with it, using its own tools, and watch the tasks it runs.
