# Deploy MisterMorph Telegram Bot to AWS Lightsail Containers

This folder provides a one-command AWS Lightsail container deployment flow for `mistermorph telegram`.

## Files

- `Dockerfile`: builds `linux/amd64` image and runs `mistermorph` via entrypoint
- `start.sh`: starts `mistermorph` in `telegram` (default) or `serve` mode
- `env.example.sh`: env template for AWS region/service/image/runtime vars
- `deploy.sh`: build, push, and create Lightsail deployment

## Prerequisites

- Docker
- AWS CLI v2 (`aws`)
- `jq`
- AWS credentials configured (`aws configure` or `aws configure sso`)
- IAM permission for Lightsail Container Service APIs

## Quickstart

```bash
cd deploy/lightsail
cp env.example.sh env.sh
# edit env.sh and fill required values
./deploy.sh
```

If you use a non-default AWS profile, set `AWS_PROFILE` in `env.sh` (or in your shell before running `deploy.sh`).

Required env vars:

- `MISTER_MORPH_LLM_API_KEY`
- `MISTER_MORPH_TELEGRAM_BOT_TOKEN`

If `MISTER_MORPH_CONFIG_PATH` is not set, `deploy.sh` defaults to repo root `config.yaml`.

## Runtime defaults (Telegram mode)

- `MISTER_MORPH_RUN_MODE=telegram`
- `MISTER_MORPH_TELEGRAM_HEALTH_ENABLED=true`
- `MISTER_MORPH_TELEGRAM_HEALTH_BIND=0.0.0.0`
- `MISTER_MORPH_TELEGRAM_HEALTH_PORT=8787`
- Lightsail public endpoint health check path: `/health`

## Optional: Persist `file_state_dir` to S3

Set these env vars (in `env.sh` or shell) before `./deploy.sh`:

- `MISTER_MORPH_S3_STATE_BUCKET`
- `MISTER_MORPH_S3_STATE_PREFIX` (for example: `prod/default`)
- `MISTER_MORPH_S3_STATE_REGION` (optional, defaults to `AWS_REGION`)
- `MISTER_MORPH_S3_SYNC_INTERVAL` (seconds, default `30`)
- `MISTER_MORPH_S3_SYNC_DELETE` (`1` mirror deletes, `0` upload only)

Behavior when enabled:

- startup: restore from `s3://<bucket>/<prefix>/state/` to `file_state_dir`
- runtime: periodic sync from `file_state_dir` to S3
- shutdown: final sync

Recommended:

- keep Lightsail scale at `1` for one shared state prefix
- use a dedicated IAM user with least privilege to that bucket/prefix only

## Notes

- `deploy.sh` builds with `--platform linux/amd64` (required for many hosted runtimes).
- `deploy.sh` never injects `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` into container runtime env.
- Lightsail deployment env vars are visible in deployment metadata. Treat this as sensitive and avoid sharing deployment JSON output.
- To view logs:

```bash
aws lightsail get-container-log --region <region> --service-name <service> --container-name <container>
```
