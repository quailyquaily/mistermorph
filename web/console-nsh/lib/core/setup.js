import { sessionStore } from "../platform";
import { endpointApiFetch, runtimeApiFetchForEndpoint } from "./context";
import { endpointRoutePath } from "./endpoint-routes";
import { CONSOLE_LOCAL_ENDPOINT_REF, visibleEndpoints } from "./endpoints";
import { loadPersonaRecord } from "./persona-profile";
import { invalidateResource, loadResource, resourceKey } from "./resources";
import { SETUP_REQUIRED_MARKDOWN_FILES } from "./setup-contract";

const SETUP_DEFERRED_STATE_FILES = new Set(["HEARTBEAT.md", "cron.yaml"]);
const SETUP_STAGE_SESSION_PREFIX = "mistermorph_console_setup_stage_v1:";
const SETUP_REPAIR_STAGE_BY_KEY = {
  config: "llm",
  identity: "persona",
  soul: "soul",
};
let setupStageSessionPrimed = false;

function normalizeEndpointItem(item) {
  return {
    endpoint_ref: typeof item?.endpoint_ref === "string" ? item.endpoint_ref.trim() : "",
    name: typeof item?.name === "string" ? item.name : "",
    url: typeof item?.url === "string" ? item.url : "",
    mode: typeof item?.mode === "string" ? item.mode : "",
    connected: item?.connected === true,
    can_submit: item?.can_submit === true,
    agent_name: typeof item?.agent_name === "string" ? item.agent_name : "",
    submit_endpoint_ref:
      typeof item?.submit_endpoint_ref === "string" ? item.submit_endpoint_ref.trim() : "",
  };
}

function buildConsoleSetupState(items) {
  const endpoints = visibleEndpoints(items).map(normalizeEndpointItem);
  const connectedEndpoints = endpoints.filter((item) => item.connected === true);
  const chatReadyEndpoints = endpoints.filter((item) => item.connected === true && item.can_submit === true);
  const consoleLocalEndpoint =
    endpoints.find((item) => item.endpoint_ref === CONSOLE_LOCAL_ENDPOINT_REF) || null;
  const requiresSetup =
    chatReadyEndpoints.length === 0 &&
    consoleLocalEndpoint?.connected === true &&
    consoleLocalEndpoint?.can_submit !== true;

  return {
    endpoints,
    connectedEndpoints,
    chatReadyEndpoints,
    consoleLocalEndpoint,
    requiresSetup,
    primaryChatReadyEndpoint: chatReadyEndpoints[0] || null,
  };
}

function consoleSetupTargetEndpointRef(state) {
  const local = state?.consoleLocalEndpoint;
  if (local?.connected === true && local?.can_submit === true && local?.endpoint_ref) {
    return local.endpoint_ref;
  }
  return state?.primaryChatReadyEndpoint?.endpoint_ref || "";
}

function setupStagePath(stage, endpointRef = CONSOLE_LOCAL_ENDPOINT_REF) {
  if (stage === "repair") {
	return endpointRoutePath(endpointRef, "/troubleshooting");
  }
  if (stage === "persona") {
    return endpointRoutePath(endpointRef, "/setup/persona");
  }
  if (stage === "soul") {
    return endpointRoutePath(endpointRef, "/setup/soul");
  }
  if (stage === "done") {
    return endpointRoutePath(endpointRef, "/setup/done");
  }
  return endpointRoutePath(endpointRef, "/setup/llm");
}

async function fetchConsoleSetupIntegrity(options = {}) {
  const endpointRef = String(options.endpointRef || "").trim() || CONSOLE_LOCAL_ENDPOINT_REF;
  return loadResource(
    resourceKey("setup", "integrity", endpointRef),
    async () => {
      const data = await endpointApiFetch(endpointRef, "/setup/integrity");
      return Array.isArray(data?.items) ? data.items : [];
    },
    {
      cache: true,
      force: options.force === true,
    }
  );
}

function blockingSetupIntegrityItems(items) {
  return Array.isArray(items)
    ? items.filter(
        (item) =>
          item &&
          typeof item.key === "string" &&
          typeof item.stage === "string" &&
          (item.status === "malformed" || item.status === "unreadable")
      )
    : [];
}

function repairStageForKey(key) {
  const normalized = typeof key === "string" ? key.trim() : "";
  return SETUP_REPAIR_STAGE_BY_KEY[normalized] || "";
}

function repairRouteForKey(key) {
  return setupStagePath(repairStageForKey(key));
}

function isAllowedRepairSetupRoute(routeLike, items) {
  const path = typeof routeLike?.path === "string" ? routeLike.path.trim() : "";
  const repairKey = typeof routeLike?.query?.repair === "string" ? routeLike.query.repair.trim() : "";
  if (!path || !repairKey) {
    return false;
  }
  const expectedPath = repairRouteForKey(repairKey);
  if (!expectedPath || path !== expectedPath) {
    return false;
  }
  return blockingSetupIntegrityItems(items).some((item) => item.key === repairKey);
}

async function consoleStateFileInfo(fileName, endpointRef = CONSOLE_LOCAL_ENDPOINT_REF) {
  const ref = typeof endpointRef === "string" ? endpointRef.trim() : "";
  if (!ref) {
    return null;
  }
  try {
    const name = encodeURIComponent(String(fileName || "").trim());
    const data = await runtimeApiFetchForEndpoint(ref, `/state/files/${name}`);
    const content = typeof data?.content === "string" ? data.content : "";
    return {
      exists: true,
      content,
    };
  } catch (err) {
    if (err?.status === 404) {
      return {
        exists: false,
        content: "",
      };
    }
    return null;
  }
}

async function consoleStateFilesIndex(endpointRef = CONSOLE_LOCAL_ENDPOINT_REF) {
  const ref = typeof endpointRef === "string" ? endpointRef.trim() : "";
  if (!ref) {
    return null;
  }
  try {
    const data = await runtimeApiFetchForEndpoint(ref, "/state/files", {
      perfSource: "setup-readiness",
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    const index = new Map();
    for (const item of items) {
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!name) {
        continue;
      }
      index.set(name, {
        exists: item?.exists === true,
        path: typeof item?.path === "string" ? item.path : "",
        group: typeof item?.group === "string" ? item.group : "",
      });
    }
    return index;
  } catch {
    return null;
  }
}

async function ensureConsoleDeferredSetupFiles(endpointRef = CONSOLE_LOCAL_ENDPOINT_REF, stateFilesIndex) {
  const ref = typeof endpointRef === "string" ? endpointRef.trim() : "";
  if (!ref) {
    return null;
  }
  const index = stateFilesIndex === undefined ? await consoleStateFilesIndex(ref) : stateFilesIndex;
  if (!index) {
    return null;
  }
  for (const file of SETUP_REQUIRED_MARKDOWN_FILES) {
    const name = typeof file?.name === "string" ? file.name.trim() : "";
    if (!name) {
      continue;
    }
    if (!SETUP_DEFERRED_STATE_FILES.has(name)) {
      continue;
    }
    if (index.get(name)?.exists === true) {
      continue;
    }
    try {
      await runtimeApiFetchForEndpoint(ref, `/state/files/${encodeURIComponent(name)}`, {
        method: "PUT",
        perfSource: "setup-readiness",
        body: {
          content: typeof file?.content === "string" ? file.content : "",
        },
      });
      index.set(name, { ...(index.get(name) || {}), exists: true });
    } catch {
      // Leave missing if the runtime cannot write yet.
    }
  }
  return index;
}

// consolePersonaRecord is the endpoint's persona (identity and soul), or null when it cannot be read.
async function consolePersonaRecord(endpointRef = CONSOLE_LOCAL_ENDPOINT_REF) {
  const ref = typeof endpointRef === "string" ? endpointRef.trim() : "";
  if (!ref) {
    return null;
  }
  try {
    return await loadPersonaRecord(
      (pathname, options) => runtimeApiFetchForEndpoint(ref, pathname, options),
      { perfSource: "setup-readiness" }
    );
  } catch {
    return null;
  }
}

async function consoleIdentityExists(endpointRef = CONSOLE_LOCAL_ENDPOINT_REF, personaRecord) {
  const record = personaRecord === undefined ? await consolePersonaRecord(endpointRef) : personaRecord;
  return record ? record.exists === true : null;
}

async function consoleSoulExists(endpointRef = CONSOLE_LOCAL_ENDPOINT_REF, personaRecord) {
  const record = personaRecord === undefined ? await consolePersonaRecord(endpointRef) : personaRecord;
  return record ? record.soulExists === true : null;
}

function setupReadinessSignature(items) {
  return JSON.stringify(
    visibleEndpoints(items).map((item) => {
      const normalized = normalizeEndpointItem(item);
      return [
        normalized.endpoint_ref,
        normalized.connected,
        normalized.can_submit,
        normalized.submit_endpoint_ref,
      ];
    })
  );
}

function setupStageSessionKey(cacheKey) {
  return `${SETUP_STAGE_SESSION_PREFIX}${cacheKey}`;
}

function readSetupStageSession(cacheKey) {
  try {
    const raw = sessionStore.getItem(setupStageSessionKey(cacheKey));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.stage !== "string" || !parsed.setup) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSetupStageSession(cacheKey, value) {
  try {
    sessionStore.setItem(setupStageSessionKey(cacheKey), JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private browsing modes.
  }
}

function clearSetupStageSession() {
  setupStageSessionPrimed = false;
  try {
    const keys = sessionStore.keys().filter((key) => key.startsWith(SETUP_STAGE_SESSION_PREFIX));
    for (const key of keys) {
      sessionStore.removeItem(key);
    }
  } catch {
    // Ignore storage cleanup errors.
  }
}

async function resolveConsoleSetupStageUncached(items, endpointRef) {
  const setup = buildConsoleSetupState(items);
  let targetEndpointRef = endpointRef;
  if (targetEndpointRef) {
    const endpoint = setup.endpoints.find((item) => item.endpoint_ref === targetEndpointRef);
    if (!endpoint || endpoint.connected !== true || endpoint.can_submit !== true) {
      return { stage: "llm", setup };
    }
  } else {
    if (setup.requiresSetup) {
      return { stage: "llm", setup };
    }
    const local = setup.consoleLocalEndpoint;
    if (local?.connected !== true || local?.can_submit !== true) {
      return { stage: "ready", setup };
    }
    targetEndpointRef = local.endpoint_ref;
  }
  const personaRecord = await consolePersonaRecord(targetEndpointRef);
  const hasIdentity = await consoleIdentityExists(targetEndpointRef, personaRecord);
  if (hasIdentity !== true) {
    return { stage: "persona", setup };
  }
  const hasSoul = await consoleSoulExists(targetEndpointRef, personaRecord);
  if (hasSoul !== true) {
    return { stage: "soul", setup };
  }
  await ensureConsoleDeferredSetupFiles(targetEndpointRef);
  return { stage: "ready", setup };
}

async function resolveConsoleSetupStage(items, options = {}) {
  const endpointRef = String(options.endpointRef || "").trim();
  const cacheKey = resourceKey(
    "setup",
    "stage",
    endpointRef,
    setupReadinessSignature(items),
  );
  const forceFresh = options.force === true || setupStageSessionPrimed !== true;
  return loadResource(
    cacheKey,
    async () => {
      if (!forceFresh) {
        const cached = readSetupStageSession(cacheKey);
        if (cached) {
          return cached;
        }
      }
      const value = await resolveConsoleSetupStageUncached(items, endpointRef);
      setupStageSessionPrimed = true;
      writeSetupStageSession(cacheKey, value);
      return value;
    },
    {
      cache: true,
      force: forceFresh,
    }
  );
}

function invalidateConsoleSetupReadiness() {
  clearSetupStageSession();
  invalidateResource(resourceKey("setup"));
}

export {
  buildConsoleSetupState,
  blockingSetupIntegrityItems,
  consoleIdentityExists,
  consoleSoulExists,
  consoleSetupTargetEndpointRef,
  consoleStateFileInfo,
  fetchConsoleSetupIntegrity,
  invalidateConsoleSetupReadiness,
  isAllowedRepairSetupRoute,
  repairRouteForKey,
  resolveConsoleSetupStage,
  setupStagePath,
};
