# Admin SPA

This directory contains the admin SPA for `mistermorph admin serve`.

- Runtime: browser-side Vue3 + Vue Router (CDN modules via importmap)
- UI: `quail-ui` from CDN
- Build: Vite (`src` -> `dist`)

## Run

1. Build frontend:

```bash
cd web/admin
pnpm install
pnpm build
```

2. Start daemon in one terminal (for current task list APIs):

```bash
MISTER_MORPH_SERVER_AUTH_TOKEN=dev-token \
go run ./cmd/mistermorph serve --server-auth-token dev-token
```

3. Start admin in another terminal:

```bash
MISTER_MORPH_ADMIN_PASSWORD=secret \
MISTER_MORPH_SERVER_AUTH_TOKEN=dev-token \
go run ./cmd/mistermorph admin serve --admin-static-dir ./web/admin/dist
```

4. Open:

`http://127.0.0.1:9080/admin`
