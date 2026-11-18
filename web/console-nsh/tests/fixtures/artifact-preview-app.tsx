// A test entry for tests/artifact-preview.test.tsx: the real ArtifactPreviewCard of a standalone
// HTML artifact, with stand-in preview tickets the test answers (`id:ticket-ok`, `id:ticket-fail`)
// in the shape the console server gives them (`entry_url` a path on the console). Headless runs
// load no pages, so the web view's own load reports are played by buttons (`id:page-*`). The
// card's state, the URL its web view got and the frames of the preview are read out below it, with
// the full-screen dialog's panel (`fullscreen-panel`, from its layout in the dialog's layer).
import { mount, signal, Text, View } from "nsh";
import { Button, watchDialogs } from "../../components/ui";
import { ArtifactPreviewCard, createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import { resolveConsoleURL } from "../../lib/core/context.js";
import type { PartFrame } from "../../components/shared/partProbe";

const KEY = "item-1:artifact:0";
const ORIGIN = "http://console.test";
const ARTIFACT = { dir_name: "file_cache_dir", path: "hello-world-20261117-185430.html" };

const tickets = signal(0);
const frames = signal<Record<string, PartFrame>>({});
// The panel is made with the card (the dialog is mounted shut), so the watcher comes first.
watchDialogs((name) =>
  name === "chat-artifact-fullscreen-dialog"
    ? {
        layout: (bounds) =>
          frames.update((all) => ({
            ...all,
            "fullscreen-panel": { x: bounds.origin.x, y: bounds.origin.y, w: bounds.size.width, h: bounds.size.height },
          })),
      }
    : undefined,
);

let answer: { resolve: (data: unknown) => void; reject: (error: Error) => void } | null = null;

const previews = createArtifactPreviews({
  createTicket: () => {
    tickets.update((n) => n + 1);
    return new Promise((resolve, reject) => (answer = { resolve, reject }));
  },
  renewTicket: (ticket) => Promise.resolve({ ticket, expires_at: new Date(Date.now() + 300000).toISOString() }),
  resolveURL: (raw) => resolveConsoleURL(ORIGIN, raw),
});

function settle(ok: boolean) {
  const current = answer;
  answer = null;
  const n = tickets();
  if (ok) {
    current?.resolve({
      ticket: `tk-${n}`,
      entry_url: `/api/artifacts/preview/tk-${n}/${ARTIFACT.path}`,
      expires_at: new Date(Date.now() + 300000).toISOString(),
    });
  } else {
    current?.reject(new Error("invalid dir_name"));
  }
}

function Control(props: { id: string; onPress: () => void }) {
  return <Button variant="plain" size="xs" label={props.id} testID={props.id} onPress={props.onPress} />;
}

function Page() {
  const state = () => previews.state(KEY);
  return (
    <View class="flex-1 gap-2 bg-background p-3">
      <View class="flex-row flex-wrap gap-1">
        <Control id="ticket-ok" onPress={() => settle(true)} />
        <Control id="ticket-fail" onPress={() => settle(false)} />
        <Control id="page-start" onPress={() => previews.pageStarted(KEY)} />
        <Control id="page-load" onPress={() => previews.pageLoaded(KEY)} />
        <Control id="page-fail" onPress={() => previews.pageFailed(KEY, { message: "net::ERR_CONNECTION_REFUSED" })} />
        <Control id="page-unsupported" onPress={() => previews.pageFailed(KEY, { message: "no web view", code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" })} />
      </View>
      <ArtifactPreviewCard
        artifact={ARTIFACT}
        endpointRef="ep_console_local"
        autoPreview
        stateKey={KEY}
        previews={previews}
        onPartLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))}
      />
      <Text testID="out-page" class="text-[6px]">page={state().page}</Text>
      <Text testID="out-tickets" class="text-[6px]">tickets={tickets()}</Text>
      <Text testID="out-entry" class="text-[6px]">entry={state().entryURL}</Text>
      <Text testID="out-frames" class="text-[6px]">frames={JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Page />);
