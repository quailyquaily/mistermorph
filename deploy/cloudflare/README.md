# Deploy Console to Cloudflare Containers

This target runs `mistermorph console serve` on port `8787`, behind a Worker.
The image builds and embeds the Console frontend. The legacy standalone `serve`
and `telegram` entrypoints are no longer supported by this target.

## Deploy

You need Docker, Node.js, npm, a Cloudflare account with Containers access, and
Wrangler authentication. The helper installs the pinned deployment dependencies
with `npm ci`. The frontend build uses pnpm inside Docker.

1. Create a private R2 bucket and S3 credentials with Object Read & Write access
   scoped to that bucket. See [R2 credentials](https://developers.cloudflare.com/r2/api/tokens/).
2. Copy `env.example.sh` to `env.sh` and fill in the Console password, a separate
   administration token, and R2 settings. Choose a unique R2 prefix per deployment.
3. Run:

```bash
cd deploy/cloudflare
./deploy.sh
```

The script loads `env.sh`. The example preserves values already exported in the
shell. It requires an explicit administration token and never rotates one silently.
Secrets are uploaded together with `wrangler secret bulk`; the script does not print
their values. `WRANGLER_ENV` selects the target environment (`prod` in the example).
For local Wrangler OAuth authentication, leave `CLOUDFLARE_API_TOKEN` unset and run
`npx --no-install wrangler login` after installing dependencies.

Open the Worker URL and sign in with `MISTER_MORPH_CONSOLE_PASSWORD`. Alternatively,
set `MISTER_MORPH_CONSOLE_PASSWORD_HASH` to a bcrypt hash and sign in with its password.
An LLM key is optional at deployment time: complete setup in Console, or configure
`MISTER_MORPH_LLM_API_KEY`, `MISTER_MORPH_LLM_INFERENCE_PROVIDER`,
`MISTER_MORPH_LLM_ENDPOINT`, and `MISTER_MORPH_LLM_MODEL` before deploying.

The minimal `config.example.yaml` seeds new state. To use another seed, set
`MISTER_MORPH_CONFIG_PATH` to an existing YAML file. The helper uploads its contents
as `MISTER_MORPH_CONFIG_YAML`, a Worker secret; it never copies that file into the
image. Seeds must fit the [5 KB Worker variable limit](https://developers.cloudflare.com/workers/platform/limits/#environment-variables);
use a minimal YAML file rather than the full commented reference template.
A seed applies only when state has no `config.yaml`. Later configuration
changes belong in Console. To remove an old seed or optional API-key override,
use `wrangler secret delete NAME` with the same config/environment.

The helper accepts no CLI arguments: use `WRANGLER_ENV` and `WRANGLER_CONFIG_PATH`
so secret uploads and deployment always target the same Worker. It is a deployment
command, not a dry run.

The root `.dockerignore` limits the build context to source inputs and excludes
local credentials, generated assets, and dependencies. These rules live at the
context root because Wrangler builds with a generated Dockerfile. Runtime images copy only
the compiled program, entrypoint, and non-sensitive seed.

## State and lifecycle

Console uses `/data/state`, including `/data/state/config.yaml`. The entrypoint:

- Restores `<R2_PREFIX>/state.tar.gz` before starting Console. A missing object
  means new state; a failed R2 request or corrupt archive stops startup.
- Uploads an archive every `MISTER_MORPH_R2_BACKUP_INTERVAL` seconds (default `60`).
- Forwards shutdown signals to Console, waits for it to exit, then uploads a final
  archive. A failed final backup produces a nonzero exit status.

**R2 backup is not a persistent disk or a transaction across files.** An abrupt
termination can lose writes since the last successful backup. A live backup can
capture files at different points in time. Only state under `/data/state` is saved;
cache files and paths outside it are not. Backup failures are logged. Monitor them
and keep independent copies of important backups. The bucket contains configuration,
conversation data, and possibly credentials entered in Console; keep it private.

This implementation deliberately uses local files plus R2 backups, rather than
putting application state on an object-storage FUSE mount with different filesystem
semantics. For workloads requiring durable acknowledgement of every write, use a
host with persistent storage. Cloudflare documents the [ephemeral disk lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).

A single named instance (`default`) owns the state, with `max_instances: 1`.
Requests cannot select another instance. Never run two deployments with the same
bucket and prefix. Existing deployments with other instance IDs must stop those
instances before migrating to this configuration.

Console stays running when browser traffic is idle. A five-minute Cron Trigger
starts it again after an unexpected exit. This incurs continuous container usage;
it is not a scale-to-zero configuration. Platform restarts and deploys can still
interrupt work. The admin stop endpoint pauses Cron recovery and browser access
until an explicit admin start. Updating secrets does not change environment
variables inside an already running container; restart it to apply them.

For disposable tests only, `MISTER_MORPH_ALLOW_EPHEMERAL_STATE=1` disables R2 backup.
Cloud deployments with this setting lose state on container replacement.

## Authentication and administration

Console handles browser login and runtime API authentication. The Worker permits
requests to login and static assets before authentication, so an anonymous request
can start the one configured instance. Apply Cloudflare Access or edge rate limits
if you need to restrict access before container startup.

Worker management endpoints require `MISTER_MORPH_SERVER_AUTH_TOKEN`; they reject
requests if that token is absent. Console requests fail closed when neither a
Console password nor password hash is configured.

```bash
curl -H "Authorization: Bearer $MISTER_MORPH_SERVER_AUTH_TOKEN" \
  https://<worker-domain>/_mistermorph/state
curl -X POST -H "Authorization: Bearer $MISTER_MORPH_SERVER_AUTH_TOKEN" \
  https://<worker-domain>/_mistermorph/stop
curl -X POST -H "Authorization: Bearer $MISTER_MORPH_SERVER_AUTH_TOKEN" \
  https://<worker-domain>/_mistermorph/start
```

`GET /_mistermorph/lifecycle` returns lifecycle information. Start and stop require
POST. Stop initiates graceful shutdown; poll state until it has stopped before
starting again. The old `hard=1` operation is rejected so shutdown can save state.

View logs with:

```bash
npx --no-install wrangler tail --config ./wrangler.jsonc --env prod
```

## Local verification

```bash
node --test deploy/cloudflare/*.test.mjs
```

Tests use fake cloud commands and do not connect to Cloudflare or a database.
To build and run the full Console image locally:

```bash
cd deploy/cloudflare
./run-local.sh
# Or seed an empty volume from a YAML file:
./run-local.sh ./custom.yaml
```

Open `http://127.0.0.1:8787`. Local runs save state in the named Docker volume
`mistermorph-console-state`, and do not read or write the cloud R2 backup. Set
`MISTER_MORPH_LOCAL_STATE_VOLUME` for a separate test installation. An existing
volume keeps its Console configuration even if you supply a different seed.
