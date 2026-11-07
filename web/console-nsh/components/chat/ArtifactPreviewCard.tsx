// An artifact the agent made (an ```artifact block naming a file in its workspace or file cache):
// a card that previews it in a web view (an image as an image), downloads it, and shows it full
// screen. Ported from web/console/src/components/ArtifactPreviewCard.js; the iframe is a WebView.
//
// The card sits in a recycled List row, so its state (expanded, the preview ticket and its renewal
// timer) lives in an ArtifactPreviews store keyed by the row's item and the block.
import { effect, Image, Text, untracked, View, WebView } from "nsh";
import { Button, Modal } from "../ui";
import { createArtifactPreviewTicket, renewArtifactPreviewTicket } from "../../lib/core/context.js";
import { t } from "./i18n";
import { keyedState } from "./rowState";
import { saveEndpointFile } from "./files";

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
};

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
export function createArtifactPreviews() {
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
    const entryURL = cleanText(data?.entry_url);
    if (!ticket || !entryURL) throw new Error(t("artifact_preview_error"));
    patch(key, { ticket, entryURL, expanded: true, error: "", frame: peek(key).frame + (reload ? 1 : 0) });
    scheduleRenew(key, data?.expires_at);
  }

  async function renew(key: string) {
    const current = peek(key);
    if (!current.expanded || !current.ticket || renewing.has(key)) return;
    renewing.add(key);
    try {
      const data = await renewArtifactPreviewTicket(current.ticket);
      patch(key, { ticket: cleanText(data?.ticket) || current.ticket });
      scheduleRenew(key, data?.expires_at);
    } catch {
      const target = targets.get(key);
      try {
        if (!target || !canPreview(target) || !peek(key).expanded) {
          clearTimer(key);
          return;
        }
        applyTicket(key, await createArtifactPreviewTicket(payload(target)), true);
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
      applyTicket(key, await createArtifactPreviewTicket(payload(target)), true);
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
      patch(key, { expanded: false, fullscreen: false, ticket: "", entryURL: "", error: "", frame: peek(key).frame + 1 });
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
      patch(key, { fullscreen });
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
}) {
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

  const frame = (tall: boolean) => (
    <If
      when={isImage()}
      else={
        <WebView
          src={state().entryURL}
          accessibilityLabel={displayPath()}
          class={`w-full ${tall ? "flex-1" : "h-96"} bg-card`}
        />
      }
    >
      <Image src={state().entryURL} accessibilityLabel={displayPath()} class="w-full" style={{ height: tall ? "100%" : 360, objectFit: "contain" }} />
    </If>
  );

  return (
    <View class="gap-2 rounded-(--radius) border border-line-faint bg-card p-3" testID="chat-artifact">
      <View class="flex-row items-center gap-2">
        <Text class="text-sm font-semibold text-foreground">{label()}</Text>
        <If when={name()}>
          <Text class="flex-1 font-mono text-xs text-muted-foreground line-clamp-1" tooltip={<Text class="text-xs">{displayPath()}</Text>}>
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
      <If when={state().expanded && state().entryURL && !state().fullscreen}>
        <View class="overflow-hidden rounded-(--radius) border border-line-faint">{frame(false)}</View>
      </If>
      <Modal
        open={state().fullscreen}
        onClose={() => props.previews.setFullscreen(props.stateKey, false)}
        title={name() || label()}
        size="full"
        scroll={false}
        closeLabel={fullscreenLabel()}
      >
        <View class="flex-1">{frame(true)}</View>
      </Modal>
    </View>
  );
}
