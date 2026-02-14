# Deployment Guide

This directory contains deployment options for `mistermorph`.

- `deploy/lightsail/`: AWS Lightsail Containers (recommended for Telegram bot mode)
- `deploy/cloudflare/`: Cloudflare Worker + Container
- `deploy/systemd/`: systemd service example (VM/server)

## Recommended Path: AWS Lightsail (Telegram Mode)

This is a step-by-step guide you can run as-is.

### 1) Prerequisites

Install:

- `aws` CLI v2
- `docker`
- `jq`

Verify:

```bash
aws --version
docker --version
jq --version
```

### 2) Configure AWS credentials

If you use default credentials (no profile):

```bash
aws configure
aws sts get-caller-identity
```

If `sts` fails, fix credentials before continuing.

### 3) Prepare deployment env file

```bash
cd deploy/lightsail
cp env.example.sh env.sh
```

Edit `deploy/lightsail/env.sh` and set at least:

- `MISTER_MORPH_LLM_API_KEY`
- `MISTER_MORPH_TELEGRAM_BOT_TOKEN`
- `MISTER_MORPH_CONFIG_PATH` (path to your `config.yaml`)

Optional but common:

- `AWS_REGION` (default `us-east-1`)
- `LIGHTSAIL_SERVICE_NAME` (default `mistermorph`)

### 4) Deploy

```bash
cd deploy/lightsail
./deploy.sh
```

What `deploy.sh` does:

1. Builds `linux/amd64` image.
2. Creates Lightsail service if missing.
3. Pushes image to Lightsail registry.
4. Creates deployment with health check on `8787/health`.

### 5) Verify deployment

Check service state:

```bash
aws lightsail get-container-services --region us-east-1 --output json \
| jq '.containerServices[] | select(.containerServiceName=="mistermorph") | {state,url,currentDeployment,nextDeployment}'
```

Expected: state moves to `RUNNING`.

Check health endpoint:

```bash
curl -i https://<your-lightsail-url>/health
```

Expected: HTTP 200.

Get logs:

```bash
aws lightsail get-container-log \
  --region us-east-1 \
  --service-name mistermorph \
  --container-name mistermorph
```

Look for:

- `telegram_start`
- `telegram_health_server_start`

Then test your bot in Telegram (for example `/id`).

## Optional: Persist state to S3

Lightsail container filesystem is ephemeral.  
To persist `file_state_dir`, enable S3 sync in `deploy/lightsail/env.sh`:

- `MISTER_MORPH_S3_STATE_BUCKET`
- `MISTER_MORPH_S3_STATE_PREFIX` (example: `mistermorph/default`)
- `MISTER_MORPH_S3_STATE_REGION` (optional)
- `MISTER_MORPH_S3_SYNC_INTERVAL` (default `30`)
- `MISTER_MORPH_S3_SYNC_DELETE` (`1` or `0`)

Behavior:

- On startup: download state from `s3://<bucket>/<prefix>/state/`
- During runtime: periodic sync upload
- On shutdown: final sync upload

For S3 sync to work inside container, runtime credentials must be provided by your runtime environment.
`deploy/lightsail/deploy.sh` intentionally does not inject `AWS_*` secrets into container env.

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN` (if temporary credentials)

## Required IAM permissions

### A) Lightsail deployment permissions (for the deploy user)

At minimum:

- `lightsail:GetContainerServices`
- `lightsail:CreateContainerService`
- `lightsail:CreateContainerServiceDeployment`
- `lightsail:PushContainerImage`
- `lightsail:GetContainerImages`
- `lightsail:GetContainerLog`
- `lightsail:CreateContainerServiceRegistryLogin`
- `sts:GetCallerIdentity`

### B) S3 state permissions (if using S3 persistence)

For bucket `mistermorph-state-prod` and prefix `mistermorph/default/state/*`:

- `s3:ListBucket` (restricted by prefix)
- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`

If your bucket enforces SSE-KMS, also add KMS key permissions:

- `kms:Encrypt`
- `kms:Decrypt`
- `kms:GenerateDataKey`

## Common errors

### `AccessDeniedException` on `lightsail:GetContainerServices`

Your deploy IAM user is missing Lightsail API permissions.  
Attach/update policy for the required Lightsail actions above.

### `AccessDenied` on `s3:PutObject`

Your runtime IAM credentials do not allow writes to the target bucket/prefix.  
Fix S3 policy scope (bucket + object ARNs + prefix condition).

### Bot does not reply immediately after deploy

Service may still be `DEPLOYING` / `ACTIVATING`.  
Wait until `RUNNING`, then check logs for `telegram_start`.

## Other deployment targets

- Cloudflare: `deploy/cloudflare/README.md`
- systemd (VM/server): `deploy/systemd/mister-morph.service`
