// An artifact the agent made (an ```artifact block naming a file in its workspace or file cache):
// a card that previews it in a web view (an image as an image), downloads it, and shows it full
// screen. Ported from web/console/src/components/ArtifactPreviewCard.js; the iframe is a WebView.
//
// The card sits in a recycled List row, so its state (expanded, the preview ticket and its renewal
// timer) lives in an ArtifactPreviews store keyed by the row's item and the block.
//
// The server answers a ticket with the preview's path on the console (`/api/artifacts/preview/…`);
// it is made absolute on the console's origin (consoleURL) before a web view gets it: nsh refuses a
// web view's or an image's URL that names no host, and the preview stayed blank. The page's own
// load reports (onLoadStart, onLoad, onError) drive what the card says meanwhile: loading, or why
// nothing shows, with a retry.
import { effect, Image, Text, untracked, View, WebView } from "nsh";
import { Button, Modal, Spinner, Tip } from "../ui";
import { consoleURL, createArtifactPreviewTicket, renewArtifactPreviewTicket } from "../../lib/core/context.js";
import { t } from "./i18n";
import { keyedState } from "./rowState";
import { createPartProbe, type PartLayoutListener } from "../shared/partProbe";
import { saveEndpointFile } from "./files";
import { CARD_CORNERS } from "../corners";

const PREVIEW_RENEW_MARGIN_MS = 60 * 1000;
const PREVIEW_RENEW_FALLBACK_MS = 4 * 60 * 1000;
const IMAGE_PREVIEW_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"]);

export interface ArtifactFields {
  path?: string;
  dir_name?: string;
  dirName?: string;
  topic_id?: string;
  topicID?: string;
  [key: string]: unknown;
}

interface PreviewTarget {
  endpointRef: string;
  dirName: string;
  topicID: string;
  path: string;
}

/** Where the shown page (or image) is: `""` before one is given, then as its loads report. */
export type ArtifactPage = "" | "loading" | "loaded" | "failed";

interface ArtifactState {
  expanded: boolean;
  loading: boolean;
  downloading: boolean;
  error: string;
  entryURL: string;
  ticket: string;
  frame: number;
  autoStarted: boolean;
  fullscreen: boolean;
  page: ArtifactPage;
  /** Why the page failed, as the card says it. */
  pageError: string;
}

const EMPTY: ArtifactState = {
  expanded: false,
  loading: false,
  downloading: false,
  error: "",
  entryURL: "",
  ticket: "",
  frame: 0,
  autoStarted: false,
  fullscreen: false,
  page: "",
  pageError: "",
};

/** What a web view's or an image's `onError` reports. */
export interface ArtifactLoadError {
  message?: string;
  code?: string;
}

/** What the card says when the page did not load: the platform shows no web views, or why it failed. */
export function artifactLoadFailure(error: ArtifactLoadError | null | undefined) {
  if (error?.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") return t("artifact_preview_unsupported");
  const reason = cleanText(error?.message);
  return reason ? `${t("artifact_preview_load_failed")} ${reason}` : t("artifact_preview_load_failed");
}

/** Where the previews get their tickets and make the preview's URL absolute (tests stand in for them). */
export interface ArtifactPreviewDeps {
  createTicket?: (payload: Record<string, string>) => Promise<any>;
  renewTicket?: (ticket: string) => Promise<any>;
  resolveURL?: (raw: string) => string;
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedTopicID(value: unknown) {
  const text = cleanText(value);
  return !text || /^<[^>]+>$/u.test(text) ? "" : text;
}

export function artifactFilename(path: string) {
  return cleanText(path).replace(/\\/gu, "/").split("/").filter(Boolean).pop() || "artifact";
}

function artifactPathExtension(path: string) {
  const name = artifactFilename(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function previewRenewDelay(expiresAt: unknown) {
  const at = Date.parse(cleanText(expiresAt));
  if (!Number.isFinite(at)) return PREVIEW_RENEW_FALLBACK_MS;
  return Math.max(1000, at - Date.now() - PREVIEW_RENEW_MARGIN_MS);
}

function canPreview(target: PreviewTarget) {
  return Boolean(target.endpointRef && target.dirName && target.path && (target.dirName !== "workspace_dir" || target.topicID));
}

function payload(target: PreviewTarget) {
  return { endpoint_ref: target.endpointRef, dir_name: target.dirName, topic_id: target.topicID, path: target.path };
}

/** The previews of one chat page; `dispose` stops their renewals when the page goes. */
export function createArtifactPreviews(deps: ArtifactPreviewDeps = {}) {
  const createTicket = deps.createTicket ?? createArtifactPreviewTicket;
  const renewTicket = deps.renewTicket ?? renewArtifactPreviewTicket;
  const resolveURL = deps.resolveURL ?? consoleURL;
  const states = keyedState<ArtifactState>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const targets = new Map<string, PreviewTarget>();
  const renewing = new Set<string>();

  const state = (key: string) => states.get(key) ?? EMPTY;
  const peek = (key: string) => untracked(() => state(key));
  const patch = (key: string, next: Partial<ArtifactState>) => states.update(key, (value) => ({ ...(value ?? EMPTY), ...next }));

  function clearTimer(key: string) {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  function scheduleRenew(key: string, expiresAt: unknown) {
    clearTimer(key);
    const current = peek(key);
    if (!current.expanded || !current.ticket) return;
    timers.set(
      key,
      setTimeout(() => void renew(key), previewRenewDelay(expiresAt)),
    );
  }

  function applyTicket(key: string, data: any, reload: boolean) {
    const ticket = cleanText(data?.ticket);
    const entryURL = resolveURL(cleanText(data?.entry_url));
    if (!ticket || !entryURL) throw new Error(t("artifact_preview_error"));
    patch(key, {
      ticket,
      entryURL,
      expanded: true,
      error: "",
      frame: peek(key).frame + (reload ? 1 : 0),
      ...(reload ? { page: "loading" as const, pageError: "" } : {}),
    });
    scheduleRenew(key, data?.expires_at);
  }

  async function renew(key: string) {
    const current = peek(key);
    if (!current.expanded || !current.ticket || renewing.has(key)) return;
    renewing.add(key);
    try {
      const data = await renewTicket(current.ticket);
      patch(key, { ticket: cleanText(data?.ticket) || current.ticket });
      scheduleRenew(key, data?.expires_at);
    } catch {
      const target = targets.get(key);
      try {
        if (!target || !canPreview(target) || !peek(key).expanded) {
          clearTimer(key);
          return;
        }
        applyTicket(key, await createTicket(payload(target)), true);
      } catch (error) {
        patch(key, { error: (error as Error)?.message || t("artifact_preview_error") });
        clearTimer(key);
      }
    } finally {
      renewing.delete(key);
    }
  }

  async function load(key: string, target: PreviewTarget) {
    if (!canPreview(target) || peek(key).loading) return;
    targets.set(key, target);
    patch(key, { loading: true, error: "" });
    try {
      applyTicket(key, await createTicket(payload(target)), true);
    } catch (error) {
      patch(key, { error: (error as Error)?.message || t("artifact_preview_error") });
    } finally {
      patch(key, { loading: false });
    }
  }

  return {
    state,
    async toggle(key: string, target: PreviewTarget) {
      patch(key, { autoStarted: true });
      if (!peek(key).expanded) {
        await load(key, target);
        return;
      }
      clearTimer(key);
      patch(key, { expanded: false, fullscreen: false, ticket: "", entryURL: "", error: "", frame: peek(key).frame + 1, page: "", pageError: "" });
    },
    /** A new ticket and a fresh page, after the page or the ticket failed. */
    async retry(key: string, target: PreviewTarget) {
      if (!canPreview(target) || peek(key).loading) return;
      clearTimer(key);
      // The failed page goes: the frame says it loads until the new ticket's page is there.
      patch(key, { autoStarted: true, entryURL: "", ticket: "", page: "", pageError: "" });
      await load(key, target);
    },
    /** The shown web view or image started loading its page (again: a navigation in it). */
    pageStarted(key: string) {
      if (!peek(key).entryURL) return;
      patch(key, { page: "loading", pageError: "" });
    },
    /** The page loaded. After a failure the web view may still finish its own error page: that stays a failure. */
    pageLoaded(key: string) {
      const current = peek(key);
      if (!current.entryURL || current.page === "failed") return;
      patch(key, { page: "loaded" });
    },
    /** The page did not load (or the app refused its URL): the card says why instead of a blank box. */
    pageFailed(key: string, error: ArtifactLoadError | null | undefined) {
      if (!peek(key).entryURL) return;
      patch(key, { page: "failed", pageError: artifactLoadFailure(error) });
    },
    autoStart(key: string, target: PreviewTarget) {
      const current = peek(key);
      if (!canPreview(target) || current.autoStarted || current.expanded || current.loading) return;
      patch(key, { autoStarted: true });
      void load(key, target);
    },
    setFullscreen(key: string, fullscreen: boolean) {
      const current = peek(key);
      if (fullscreen && (!current.expanded || !current.entryURL || current.loading)) return;
      if (current.fullscreen === fullscreen) return;
      // The page loads again in the web view that takes over (the dialog's, or the card's).
      patch(key, current.page === "failed" ? { fullscreen } : { fullscreen, page: "loading", pageError: "" });
    },
    async download(key: string, target: PreviewTarget) {
      if (!canPreview(target) || peek(key).downloading) return;
      patch(key, { downloading: true, error: "" });
      try {
        const query = new URLSearchParams();
        query.set("dir_name", target.dirName);
        query.set("path", target.path);
        if (target.topicID) query.set("topic_id", target.topicID);
        await saveEndpointFile(target.endpointRef, `/files/download?${query.toString()}`, artifactFilename(target.path));
      } catch (error) {
        patch(key, { error: (error as Error)?.message || t("artifact_preview_error") });
      } finally {
        patch(key, { downloading: false });
      }
    },
    dispose() {
      for (const key of [...timers.keys()]) clearTimer(key);
      targets.clear();
    },
  };
}

export type ArtifactPreviews = ReturnType<typeof createArtifactPreviews>;

export function ArtifactPreviewCard(props: {
  artifact: ArtifactFields;
  endpointRef: string;
  fallbackTopicID?: string;
  autoPreview?: boolean;
  stateKey: string;
  previews: ArtifactPreviews;
  /** For tests: where the preview's frame lies (`chat-artifact-frame`, `chat-artifact-fullscreen-frame`). */
  onPartLayout?: PartLayoutListener;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  const target = (): PreviewTarget => ({
    endpointRef: cleanText(props.endpointRef),
    dirName: cleanText(props.artifact?.dir_name || props.artifact?.dirName),
    topicID: normalizedTopicID(props.artifact?.topic_id || props.artifact?.topicID) || normalizedTopicID(props.fallbackTopicID),
    path: cleanText(props.artifact?.path),
  });
  const state = () => props.previews.state(props.stateKey);
  const available = () => canPreview(target());
  const isImage = () => IMAGE_PREVIEW_EXTENSIONS.has(artifactPathExtension(target().path));
  const displayPath = () => `${target().dirName}/${target().path}`;
  const name = () => (target().path ? artifactFilename(target().path) : "");
  const label = () => (isImage() ? t("artifact_preview_type_image") : t("artifact_preview_type_web"));
  const fullscreenLabel = () =>
    state().fullscreen ? t("artifact_preview_action_exit_fullscreen") : t("artifact_preview_action_fullscreen");

  // The latest finished reply with an artifact opens its preview by itself, once.
  effect(() => {
    if (!props.autoPreview || !available()) return;
    const key = props.stateKey;
    const next = target();
    untracked(() => props.previews.autoStart(key, next));
  });

  const key = () => props.stateKey;
  const started = () => props.previews.pageStarted(key());
  const loaded = () => props.previews.pageLoaded(key());
  const failed = (error: ArtifactLoadError) => props.previews.pageFailed(key(), error);
  // The ticket is on its way (first opening, a retry), or the page has not loaded yet.
  const pending = () => state().loading || state().page === "loading";
  const part = (tall: boolean, name: string) => `chat-artifact-${tall ? "fullscreen-" : ""}${name}`;

  // The page, or what shows in its place: the loading note while there is none yet, and the reason
  // when it failed. The note over a page that loads lets touches through to it.
  const frame = (tall: boolean) => (
    <View class={`relative w-full ${tall ? "flex-1" : "h-96"}`} testID={part(tall, "frame")} {...parts.probe(() => part(tall, "frame"))}>
      <If
        when={state().page === "failed"}
        else={
          <If
            when={state().entryURL}
            else={<View class="absolute inset-0 bg-card" />}
          >
            <If
              when={isImage()}
              else={
                <WebView
                  src={state().entryURL}
                  accessibilityLabel={displayPath()}
                  class="h-full w-full bg-card"
                  testID={part(tall, "web")}
                  onLoadStart={started}
                  onLoad={loaded}
                  onError={failed}
                />
              }
            >
              <Image
                src={state().entryURL}
                accessibilityLabel={displayPath()}
                class="overflow-hidden h-full w-full"
                style={{ objectFit: "contain" }}
                testID={part(tall, "image")}
                onLoad={loaded}
                onError={failed}
              />
            </If>
          </If>
        }
      >
        <View class="absolute inset-0 items-center justify-center gap-3 bg-card p-4" testID={part(tall, "failed")}>
          <Text role="alert" class="text-center text-sm text-danger">
            {state().pageError || t("artifact_preview_load_failed")}
          </Text>
          <Button
            variant="outlined"
            size="sm"
            align="center"
            label={t("artifact_preview_action_retry")}
            disabled={!available()}
            loading={state().loading}
            onPress={() => void props.previews.retry(key(), target())}
            testID={part(tall, "retry")}
          />
        </View>
      </If>
      <If when={pending() && state().page !== "failed"}>
        <View class="absolute inset-x-0 top-0 items-center p-3" style={{ pointerEvents: "none" }} testID={part(tall, "loading")}>
          <View class="flex-row items-center gap-2 rounded-full border border-line-faint bg-card px-3 py-1.5">
            <Spinner size={16} />
            <Text class="text-xs text-muted-foreground">
              {t("artifact_preview_loading")}
            </Text>
          </View>
        </View>
      </If>
    </View>
  );

  return (
    <View class={`gap-2 ${CARD_CORNERS} border border-line-faint bg-card p-3`} testID="chat-artifact">
      <View class="flex-row items-center gap-2">
        <Text class="text-sm font-semibold text-foreground">{label()}</Text>
        <If when={name()}>
          <Text class="flex-1 font-mono text-xs text-muted-foreground line-clamp-1" tooltip={<Tip text={displayPath()} />}>
            {name()}
          </Text>
        </If>
        <If when={!name()}>
          <View class="flex-1" />
        </If>
        <Button
          variant="plain"
          size="xs"
          iconOnly
          icon={state().expanded ? "PhCaretUp" : "PhCaretDown"}
          title={state().expanded ? t("artifact_preview_action_collapse") : t("artifact_preview_action_expand")}
          disabled={!available()}
          loading={state().loading}
          onPress={() => void props.previews.toggle(props.stateKey, target())}
        />
        <Button
          variant="plain"
          size="xs"
          iconOnly
          icon="PhCloudArrowDown"
          title={t("chat_workspace_action_download")}
          disabled={!available()}
          loading={state().downloading}
          onPress={() => void props.previews.download(props.stateKey, target())}
        />
        <Button
          variant="plain"
          size="xs"
          iconOnly
          icon="PhCornersOut"
          title={fullscreenLabel()}
          disabled={!available() || !state().expanded || !state().entryURL}
          onPress={() => props.previews.setFullscreen(props.stateKey, true)}
        />
      </View>
      <If when={state().error}>
        <Text role="alert" class="text-xs text-danger">
          {state().error}
        </Text>
      </If>
      <If when={((state().expanded && state().entryURL) || state().loading) && !state().fullscreen}>
        <View class={`overflow-hidden ${CARD_CORNERS} border border-line-faint`}>{frame(false)}</View>
      </If>
      {/* Full screen: the page fills the dialog below its title bar, edge to edge (`flush`, no body
          padding); the panel keeps its place inside the system's insets, and its close button. */}
      <Modal
        open={state().fullscreen}
        onClose={() => props.previews.setFullscreen(props.stateKey, false)}
        title={name() || label()}
        size="full"
        scroll={false}
        flush
        closeLabel={fullscreenLabel()}
        testID="chat-artifact-fullscreen-dialog"
      >
        {frame(true)}
      </Modal>
    </View>
  );
}
