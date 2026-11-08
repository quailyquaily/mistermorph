# Extension Points

This document lists the extension points intended for downstream builds.

The rule is simple: upstream keeps generic hooks, downstream keeps product-specific code. The default upstream build must behave the same when no extension is provided.

## Console Backend Routes

Console backend API routes are registered in `cmd/mistermorph/consolecmd`.

Downstream code in the same Go package can register extra routes during `init()`:

```go
package consolecmd

import "net/http"

func init() {
	registerConsoleRouteRegistrar(func(mux *http.ServeMux, srv *server, apiPrefix string) {
		mux.HandleFunc(apiPrefix+"/pro/skill-store/skills", srv.withAuth(handleProSkills))
	})
}

func handleProSkills(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": []any{}})
}
```

Notes:

- `apiPrefix` already includes `console.base_path`. With `console.base_path: /console`, the API prefix is `/console/api`.
- Registrars run after upstream API routes are registered and before the SPA fallback is registered.
- Use `srv.withAuth(...)` for protected routes.
- This is a same-package extension point. It does not export `server` as a public API.
- Duplicate route patterns will fail through `http.ServeMux`, so downstream routes should use their own prefix such as `/pro/...`.

## Console Frontend

The Console is `web/console-nsh`, a TSX app on nsh. Its extension modules are plain modules a
downstream build replaces by source overlay; each must keep the names and shapes below. The open
build leaves all of them empty.

### Setup-free paths

```text
web/console-nsh/lib/ext/routes/index.js
```

```js
export const routeExtensions = {
  setupFreePaths: [],
};
```

`setupFreePaths` is added to the setup guard's allowlist (lib/router.ts). It only bypasses the
setup-completion guard; it does not make a route public, and normal Console auth still applies.
There is no hook for extra pages yet.

### Slots

```text
web/console-nsh/components/frame/slots.ts
```

| Slot id | Location | Props |
| --- | --- | --- |
| `sidebar.before_runtime` | In the sidebar's navigation, just before Settings (not in the folded sidebar), and in the phone's More menu. | `selectedEndpointItem`, `currentPath`, `mobile`, `t` |
| `sidebar.bottom_left` | At the foot of the sidebar (not in the folded sidebar), and at the foot of the phone's More menu. | `selectedEndpointItem`, `currentPath`, `t` |

A slot is a function component, `(props: SidebarSlotProps) => JSX.Element`; `null` renders
nothing:

```tsx
import { SkillStoreNavEntry } from "pro-console/SkillStoreNavEntry";
import { AccountBadge } from "pro-console/AccountBadge";

export const uiSlots = {
  "sidebar.before_runtime": SkillStoreNavEntry,
  "sidebar.bottom_left": AccountBadge,
};
```

Slot components may use the Console's own helpers (API functions, `translate`, the UI kit in
`components/ui.tsx`).

### i18n

```text
web/console-nsh/lib/ext/i18n/index.js
```

```js
export const i18nExtensions = {};
```

Downstream builds can provide extra message keys:

```js
export const i18nExtensions = {
  en: {
    skill_store_title: "Skill Store",
    skill_store_installed: "Installed",
  },
  zh: {
    skill_store_title: "技能市场",
    skill_store_installed: "已安装",
  },
  ja: {
    skill_store_title: "Skill Store",
    skill_store_installed: "インストール済み",
  },
};
```

Lookup order:

1. Current locale in upstream core messages.
2. English upstream core messages.
3. Current locale in `i18nExtensions`.
4. English `i18nExtensions`.
5. The key itself.

Core messages win over extension messages. Use extension-specific key names to avoid accidental
collisions. Variable replacement uses the `{name}` syntax: `translate("skill_store_count", { count: 3 })`.

Keep extension modules small. They should register slots, setup-free paths or messages. Product
logic belongs in downstream components and API handlers.
