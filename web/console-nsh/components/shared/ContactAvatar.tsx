// ContactAvatar shows a contact's avatar, or its initial. The avatar is the contact's own, stored by
// its runtime and downloaded through /api/proxy/download when the avatar is created (a List creates
// its rows as they scroll into view), or imageURL, an image the Console already holds (an Agent Link
// contact's agent avatar, a data URL), which takes precedence.
//
// Ported from web/console/src/components/ContactAvatar.js. The Vue version waited for an
// IntersectionObserver; nsh has none, so the download starts when the avatar is made, and a
// module-level cache keeps recycled List rows from downloading the same avatar again.
import { cleanup, computed, effect, Image, signal, Text, untracked, View } from "nsh";
import { CutoutAvatar } from "./CutoutAvatar";
import { runtimeApiDownloadForEndpoint } from "../../lib/core/context.js";

export interface ContactAvatarProps {
  /** The contact: its `avatar_url` is the runtime path of its avatar. */
  item: { avatar_url?: string | null; [key: string]: unknown } | null | undefined;
  /** An image the Console already holds; wins over the contact's own avatar. */
  imageURL?: string;
  /** The name whose first letter shows when there is no image. */
  name?: string;
  /** The endpoint the contact belongs to (its avatar is downloaded from there). */
  endpointRef: string;
  /** `list` (40 points), `detail` (64 points), or a diameter of its own in points (the Contacts
   * library's cards and panel). */
  size?: "list" | "detail" | number;
  /** A round notch cut out of the avatar where a badge sits (its centre and radius, in points): the
   * row behind shows through the gap instead of the badge wearing a ring. Drawn on a canvas
   * (CutoutAvatar), so every platform cuts it. */
  notch?: { x: number; y: number; r: number };
  class?: string;
  testID?: string;
}

const CACHE_LIMIT = 200;
// endpointRef + "\u0000" + path -> blob URL, oldest first.
const downloaded = new Map<string, string>();

function remember(key: string, url: string) {
  downloaded.delete(key);
  downloaded.set(key, url);
  while (downloaded.size > CACHE_LIMIT) {
    const oldest = downloaded.keys().next().value as string;
    const stale = downloaded.get(oldest);
    downloaded.delete(oldest);
    if (stale) URL.revokeObjectURL(stale);
  }
}

/** The first letter of `name`, upper-cased, or "?". */
export function contactInitial(name: string | undefined | null) {
  return Array.from(String(name || "").trim())[0]?.toUpperCase() || "?";
}

export function ContactAvatar(props: ContactAvatarProps) {
  const source = signal("");
  const failed = signal(false);
  let requestID = 0;

  // Computed, so a new contact object with the same avatar (a reloaded list) does not reload it.
  const directURL = computed(() => String(props.imageURL || "").trim());
  const avatarPath = computed(() => (directURL() ? "" : String(props.item?.avatar_url || "").trim()));
  const shown = () => (directURL() ? (failed() ? "" : directURL()) : source());
  const dimension = () => (typeof props.size === "number" ? props.size : props.size === "detail" ? 64 : 40);

  async function load(endpointRef: string, path: string, ticket: number) {
    const key = `${endpointRef}\u0000${path}`;
    const cached = downloaded.get(key);
    if (cached) {
      source.set(cached);
      return;
    }
    try {
      const blob = (await runtimeApiDownloadForEndpoint(endpointRef, path, { cache: "force-cache" })) as Blob;
      const url = URL.createObjectURL(blob);
      remember(key, url);
      if (ticket === requestID) source.set(url);
    } catch (error) {
      if (ticket === requestID) {
        console.warn("contact avatar", path, (error as Error)?.message);
        failed.set(true);
      }
    }
  }

  effect(() => {
    const endpointRef = String(props.endpointRef || "").trim();
    const path = avatarPath();
    directURL();
    untracked(() => {
      requestID += 1;
      source.set("");
      failed.set(false);
      if (endpointRef && path) void load(endpointRef, path, requestID);
    });
  });
  cleanup(() => {
    requestID += 1;
  });

  function handleImageError() {
    requestID += 1;
    const path = avatarPath();
    if (path) downloaded.delete(`${String(props.endpointRef || "").trim()}\u0000${path}`);
    source.set("");
    failed.set(true);
  }

  const initial = () => (
    <Text
      class={`font-semibold leading-none text-blue ${typeof props.size === "number" ? "" : props.size === "detail" ? "text-[22px]" : "text-[15px]"}`}
      // A diameter of its own: the initial at the same share of it as the 64pt avatar's 22pt.
      style={typeof props.size === "number" ? { fontSize: Math.round(props.size * 0.34) } : undefined}
    >
      {contactInitial(props.name)}
    </Text>
  );
  // With a notch, the disc (its paper, the image, the hairline) is drawn cut; the initial sits on
  // it, clear of the notch.
  if (props.notch) {
    return (
      <View
        testID={props.testID}
        accessibilityElementsHidden
        class={`items-center justify-center ${props.class ?? ""}`}
        style={{ width: dimension(), height: dimension(), minWidth: dimension() }}
      >
        <CutoutAvatar
          size={dimension()}
          src={shown() || null}
          background="#ffffff"
          notch={props.notch}
          onError={handleImageError}
          class="absolute left-0 top-0"
        />
        <If when={!shown()}>{initial()}</If>
      </View>
    );
  }
  return (
    <View
      testID={props.testID}
      accessibilityElementsHidden
      class={`items-center justify-center overflow-hidden rounded-full bg-white ${props.class ?? ""}`}
      style={{
        width: dimension(),
        height: dimension(),
        minWidth: dimension(),
        // A faint inner hairline keeps a pale avatar from melting into the row.
        boxShadow: "inset 0 0 0 1px rgba(24, 24, 50, 0.09)",
      }}
    >
      <If
        when={shown()}
        else={initial()}
      >
        {(src) => (
          <Image
            src={src()}
            onError={handleImageError}
            style={{ width: dimension(), height: dimension(), objectFit: "cover" }}
          />
        )}
      </If>
    </View>
  );
}
