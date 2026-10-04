# Deployment Guide

This directory contains deployment targets for `mistermorph`.

This page helps you pick a target quickly.
Use target-specific READMEs for exact setup steps, env vars, and troubleshooting.

## Quick Decision Guide

1. Choose **AWS Lightsail** if you want the fastest container rollout for a Telegram bot and you are already on AWS.
2. Choose **Cloudflare Worker + Container** if you want edge ingress and public access to Console with R2 state backups.
3. Choose **systemd on VM/server** if you want maximum control over host, networking, storage, and hardening.

## Deployment Docs Index

| Target | Best for | Entry doc |
|---|---|---|
| AWS Lightsail Containers | Telegram bot mode with simple one-command rollout | [`deploy/lightsail/README.md`](./lightsail/README.md) |
| Cloudflare Worker + Container | Edge ingress + containerized Console with R2 state backups | [`deploy/cloudflare/README.md`](./cloudflare/README.md) |
| systemd on VM/server | Self-hosted Linux VM with hardened service unit | [`deploy/systemd/README.md`](./systemd/README.md) |

## Pros and Cons

### AWS Lightsail Containers

Pros:
- Fastest path to first deploy with `deploy.sh`.
- Good fit for single-instance Telegram long polling.
- Familiar AWS IAM + S3-based operations.

Cons:
- AWS-specific workflow and service limits.
- Less flexible than running your own VM/service manager.
- Not ideal if you need advanced edge routing.

### Cloudflare Worker + Container

Pros:
- Edge front door with global ingress.
- Console UI and API behind one public endpoint.
- Built-in request routing and lightweight control endpoints.

Cons:
- More moving parts (Worker + container + Wrangler).
- Cloudflare platform coupling.
- R2 backups have a recovery window; container disk is ephemeral.
- Console stays running and incurs continuous container usage.

### systemd on VM/server

Pros:
- Full control over binary, filesystem, process model, and security hardening.
- Easy integration with existing VM monitoring/logging/backup workflows.
- Lowest platform lock-in.

Cons:
- You own OS patching, uptime, and host security.
- More manual setup for ingress, TLS, and scaling.
- Requires Linux/systemd ops familiarity.
