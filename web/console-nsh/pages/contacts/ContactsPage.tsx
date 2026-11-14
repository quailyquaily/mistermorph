// The agent's contacts (web/console/src/views/ContactsView.js) as a library: a grid of contact cards
// (pages/contacts/ContactCard.tsx) with a filter, and the picked contact in a panel at the right,
// the Skill Store's frame: its avatar, the owner switch, its connections (copyable handles), the
// agent's memories about it, its activity, and its YAML for editing. On a phone the library and the
// contact take turns, with a back button.
//
// Motion (the library's own is in ContactCard.tsx):
// - Opening a contact: the panel comes in from the right (24pt, fading, 280 ms) while the library
//   makes room for it, its cards sliding along their rows or fading in on another one; the panel's
//   sections rise into place one after another, and its avatar comes into focus from coarse pixels
//   (components/motion/PixelResolve.tsx: the brand's "pixel becomes smooth").
// - Another contact while it is open: the panel stays; its contents turn over (a quick fade and a
//   4pt rise, no blank moment) and the new avatar comes into focus. The selection is one highlight
//   over the grid that glides from card to card, as the column lists' does (SlidingSelection);
//   while the grid makes room it moves with its card, along the row, or straight to the card's new
//   row as the card fades in there.
// - Closing (its close button, Escape): the panel leaves on the exit curve (200 ms) while the
//   library takes the room back.
// - The first load: the cards rise in a diagonal cascade. A filter: the cards it takes out shrink
//   and fade, then the rest close ranks.
// Send message: a short compose dialog whose Send hands the message to the agent as a task in a new
// topic (contacts_send, word for word, as the Skill Store's Install is a task), and opens that topic.
// Keys (desktops): the arrows walk the grid (opening the contact they land on while the panel is
// open), Enter opens the selected card, Escape closes the panel.
import { batch, cleanup, computed, createAnimatedValue, createMotion, effect, keymap, List, platform, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX, ListRef } from "nsh";
import {
  Blocks,
  gutterX,
  IndexColumn,
  IndexSearch,
  InlineNotice,
  MobileBar,
  MoreTrigger,
  Note,
  SwitchOnly,
  t,
} from "../../components/knowledge/parts";
import { Button, CircleButton, DropdownMenu, Icon, MessageDialog, Modal, Page, popupOpen, TextField, POPUP_RADIUS, type IconName } from "../../components/ui";
import { createSlidingSelection, FadeText, MOTION_EASE, MOTION_EXIT_EASE, motionMs, SCROLLBAR } from "../../components/motion";
import { createPaneStack } from "../../components/motion/PaneStack";
import { endpointState, formatShortTime, runtimeApiFetch, runtimeApiFetchForEndpoint } from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { useNotice } from "../../lib/core/notices.js";
import { copyText } from "../../lib/platform";
import { locationOf, navigate } from "../../lib/router";
import { isMobile, markMobileDetail } from "../../lib/shell";
import { useContactsStore } from "../../lib/stores/contactsStore.js";
import {
  channelHandles,
  channelLabel,
  channelLogo,
  displayName,
  isAgent,
  kindText,
  matchesFilter,
  relativeTime,
  type Contact,
} from "./contact-format";
import { CARD_HEIGHT, cardPlace, ChannelMark, ContactCard, contactID, KindAvatar, type LibraryGeometry, type LibraryMotion } from "./ContactCard";
import { MobileBarSpacer } from "../../components/frame/mobileBar";
import { createPullSearch } from "../../components/shared/pullSearch";

type Memory = { id: string; description?: string; body?: string };

/** The panel's paper, and the room round it (12pt off the window's edges and the library). */
const PANEL_WIDTH = 404;
const PANEL_INSET = 12;
const PANEL_AVATAR = 88;
const PANEL_SHADOW = "0 1px 2px rgba(24, 46, 72, 0.05), 0 18px 40px rgba(24, 46, 72, 0.10)";
/** The cards' least width and the gaps between them: a desktop's, a phone's. */
const CARD_MIN = { desktop: 188, phone: 150 };
const CARD_GAP = { desktop: 14, phone: 10 };

/** A section's head in the panel: the square mark in blue, the title as a mono label in brackets,
 *  and a hairline to the edge (design/DESIGN.md, Sections). */
function SectionHead(props: { text: string }) {
  return (
    <View class="flex-row items-center gap-2">
      <View class="size-1.5 bg-blue" />
      <Text role="header" class="font-mono text-[10.5px] font-medium uppercase leading-[14px] tracking-[0.16em] text-muted-foreground">
        {`[${props.text}]`}
      </Text>
      <View class="h-px flex-1 bg-line-soft" />
    </View>
  );
}

/** A 32pt plain copy button with a 14pt icon (.contacts-copy-action). */
function CopyButton(props: { onPress: () => void; testID?: string }) {
  return (
    <Button variant="plain" size="xs" iconOnly title={t("action_copy")} onPress={() => props.onPress()} testID={props.testID} class="size-8">
      <Icon name="PhCopy" size={14} color="muted-foreground" />
    </Button>
  );
}

/** One line of the activity section: its icon, a 12pt label, the 16pt value, the time in mono under it. */
function ActivityItem(props: { icon: IconName; label: string; value: string; time: string; divided?: boolean }) {
  return (
    <View class={`flex-row items-start gap-2.5 pb-3.5 ${props.divided ? "border-t border-line-soft pt-3.5" : "pt-1"}`}>
      <View class="w-[22px] pt-0.5">
        <Icon name={props.icon} size={18} color="muted-foreground" />
      </View>
      <View class="flex-1 gap-0.5">
        <Text class="text-xs leading-[18px] text-muted-foreground">{props.label}</Text>
        <Text class="text-base font-bold leading-[22px] text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
          {props.value}
        </Text>
        <If when={props.time}>
          <Text class="font-mono text-[11.5px] leading-[17px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
            {props.time}
          </Text>
        </If>
      </View>
    </View>
  );
}

/** A section of the panel that rises into place when the panel opens, `order` after the head. */
function Rise(props: { order: number; class?: string; testID?: string; children?: JSX.Element }) {
  const motion = createMotion();
  const ms = motionMs(300);
  if (ms > 0 && !untracked(isMobile)) {
    motion.opacity.set(0);
    motion.translateY.set(6);
    void motion.play(
      { keyframes: { opacity: [{ value: 0, easing: MOTION_EASE }, 1], translateY: [{ value: 6, easing: MOTION_EASE }, 0] } },
      { duration: ms, delay: 60 + props.order * 40 },
    );
  }
  return (
    <View class={props.class} testID={props.testID} style={motion.style}>
      {props.children}
    </View>
  );
}

export function ContactsPage() {
  const notice = useNotice();
  const store = useContactsStore();

  const err = signal("");
  const filterText = signal("");
  // On a touch phone the filter hides until the library is pulled down from its top
  // (components/shared/pullSearch.ts), then heads it; once shown it stays while the page lives, the
  // library being rebuilt each time the phone comes back from a contact.
  const filterRevealed = signal(false);
  const selectedContactID = signal("");
  // The card the keys stand on (desktops): the open contact's, or one the arrows moved to.
  const highlightID = signal("");
  const mobileEditorVisible = signal(false);

  const editingContactID = signal("");
  const editorYAML = signal("");
  const loadedEditorYAML = signal("");
  const editorLoading = signal(false);
  const editorSaving = signal(false);
  const ownerSaving = signal(false);
  // Rebuilds the switch after a failed save, so it shows the stored value again.
  const ownerSwitchKey = signal(0);
  const editorErr = signal("");

  const deleteDialogOpen = signal(false);
  const deleteTarget = signal<Contact | null>(null);
  const deleting = signal(false);

  // Send message: the dialog, the contact it writes to, its text, and the task being handed over.
  const sendOpen = signal(false);
  const sendTarget = signal<Contact | null>(null);
  const sendText = signal("");
  const sendBusy = signal(false);
  const sendErr = signal("");

  /* ---------- the library's motion ---------- */

  // What moves the cards now (ContactCard.tsx): set just before the library changes, cleared once
  // its motion is over, so scrolling (recycled cards) never moves anything.
  const libraryMotion = signal<LibraryMotion>(null);
  let motionTimer: ReturnType<typeof setTimeout> | undefined;
  function arm(kind: Exclude<LibraryMotion, null>, ms: number) {
    clearTimeout(motionTimer);
    libraryMotion.set(kind);
    motionTimer = setTimeout(() => libraryMotion.set(null), ms);
  }
  cleanup(() => clearTimeout(motionTimer));
  // Where each card was (its index and grid), across the list's recycling.
  const places = new Map<string, { index: number; geometry: LibraryGeometry }>();

  // The filter the library shows: a change that takes cards out lets them fade first (140 ms).
  const appliedFilter = signal("");
  const leavingIDs = signal<ReadonlySet<string>>(new Set());
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(filterTimer));

  const items = () => (store.items || []) as Contact[];
  const filteredItems = () => items().filter((item) => matchesFilter(item, appliedFilter()));
  function applyFilter(next: string) {
    clearTimeout(filterTimer);
    batch(() => {
      for (const id of untracked(leavingIDs)) places.delete(id);
      leavingIDs.set(new Set());
      arm("glide", 600);
      appliedFilter.set(next);
    });
  }
  effect(() => {
    const next = filterText();
    untracked(() => {
      if (next === appliedFilter()) return;
      const going = filteredItems()
        .filter((item) => !matchesFilter(item, next))
        .map(contactID);
      if (!going.length || motionMs(1) <= 0 || store.loading) {
        applyFilter(next);
        return;
      }
      clearTimeout(filterTimer);
      leavingIDs.set(new Set(going));
      filterTimer = setTimeout(() => applyFilter(next), 140);
    });
  });

  const selectedContact = computed(() => {
    const id = selectedContactID().trim();
    return id ? items().find((item) => contactID(item) === id) || null : null;
  });
  const connectionsOf = (contact: Contact | null) => {
    const handles = channelHandles(contact);
    if (handles.length > 0) return handles.map((handle) => ({ ...handle, logo: channelLogo(handle.channelKey), copyable: true }));
    const channelKey = String(contact?.channel || "").trim().toLowerCase();
    return [
      {
        key: `primary:${channelKey}`,
        channelKey,
        channel: channelLabel(channelKey),
        full: t("contacts_connection_primary"),
        short: "",
        logo: channelLogo(channelKey),
        copyable: false,
      },
    ];
  };

  // The agent's memories about the selected contact.
  const selectedMemories = signal<Memory[]>([]);
  const memoriesLoading = signal(false);
  async function loadSelectedMemories(id: string) {
    selectedMemories.set([]);
    if (!id || !endpointState.selectedRef) return;
    memoriesLoading.set(true);
    try {
      const data = await runtimeApiFetch(`/memories?subject=${encodeURIComponent(`contact:${id}`)}`);
      if (untracked(selectedContactID).trim() === id) selectedMemories.set(Array.isArray(data?.items) ? data.items : []);
    } catch (e: any) {
      // A runtime without memories has none to show.
      console.warn("contact memories:", e?.message);
    } finally {
      memoriesLoading.set(false);
    }
  }
  effect(() => {
    const id = selectedContactID().trim();
    untracked(() => void loadSelectedMemories(id));
  });
  function openMemories() {
    const id = untracked(selectedContactID).trim();
    void navigate(locationOf(endpointRoutePath(endpointState.selectedRef, "/memories"), { subject: `contact:${id}` }));
  }

  const editing = () => Boolean(selectedContact()) && editingContactID() === selectedContactID();
  const saveDisabled = () =>
    editorLoading() || editorSaving() || !editing() || !String(editorYAML() || "").trim() || editorYAML() === loadedEditorYAML();

  const showIndexPane = () => !isMobile() || !mobileEditorVisible();
  const showEditorPane = () => isMobile() && mobileEditorVisible();
  const mobileShowBack = () => isMobile() && mobileEditorVisible();
  // An open contact is not the navigation's page: the bottom navigation steps aside.
  markMobileDetail(mobileShowBack);
  const mobileBarTitle = () => (mobileShowBack() && selectedContact() ? displayName(selectedContact()) : t("contacts_title"));
  const deleteDialogText = () => t("contacts_delete_confirm", { name: displayName(deleteTarget() || selectedContact()) });

  // Leaving the phone layout shows the library again.
  effect(() => {
    if (!isMobile()) untracked(() => mobileEditorVisible.set(false));
  });
  // On phones the library (0) and a contact (1) are levels of the page that slide (PaneStack); the
  // contact keeps its bar while it goes out.
  const panes = createPaneStack(() => (isMobile() ? (mobileEditorVisible() ? 1 : 0) : null));
  const heldBarTitle = panes.held(1, mobileBarTitle);
  const shownContact = panes.held(1, selectedContact);

  /* ---------- the panel (desktops) ---------- */

  // What the panel shows, kept while it goes out; whether it is going out.
  const panelContact = signal<Contact | null>(null);
  const panelLeaving = signal(false);
  const panelMotion = createMotion();
  effect(() => {
    const contact = isMobile() ? null : selectedContact();
    untracked(() => {
      const shown = panelContact();
      if (contact) {
        const opening = !shown || panelLeaving();
        batch(() => {
          panelLeaving.set(false);
          panelContact.set(contact);
        });
        if (!opening) return;
        // The library makes room as the panel comes in.
        arm("glide", 600);
        const ms = motionMs(280);
        if (ms <= 0) return;
        panelMotion.opacity.set(0);
        panelMotion.translateX.set(24);
        void panelMotion.play(
          { keyframes: { opacity: [{ value: 0, easing: MOTION_EASE }, 1], translateX: [{ value: 24, easing: MOTION_EASE }, 0] } },
          { duration: ms },
        );
      } else if (shown && !panelLeaving()) {
        const ms = motionMs(200);
        if (ms <= 0 || isMobile()) {
          panelContact.set(null);
          return;
        }
        // It leaves the row at once (the library takes the room back) and goes out over it.
        arm("glide", 600);
        panelLeaving.set(true);
        void panelMotion
          .play(
            { keyframes: { opacity: [{ value: 1, easing: MOTION_EXIT_EASE }, 0], translateX: [{ value: 0, easing: MOTION_EXIT_EASE }, 20] } },
            { duration: ms },
          )
          .then(() => {
            if (!untracked(panelLeaving)) return;
            batch(() => {
              panelLeaving.set(false);
              panelContact.set(null);
            });
          });
      }
    });
  });

  // Another contact while the panel is open: its contents turn over (a quick fade, a 4pt rise).
  const bodyMotion = createMotion();
  let bodyShownID = "";
  effect(() => {
    const id = contactID(panelContact());
    untracked(() => {
      const before = bodyShownID;
      bodyShownID = id;
      if (!before || !id || before === id || panelLeaving()) return;
      const ms = motionMs(220);
      if (ms <= 0) return;
      bodyMotion.opacity.set(0.35);
      bodyMotion.translateY.set(4);
      void bodyMotion.play(
        { keyframes: { opacity: [{ value: 0.35, easing: MOTION_EASE }, 1], translateY: [{ value: 4, easing: MOTION_EASE }, 0] } },
        { duration: ms },
      );
    });
  });

  function stopEdit() {
    batch(() => {
      editingContactID.set("");
      editorYAML.set("");
      loadedEditorYAML.set("");
      editorLoading.set(false);
      editorSaving.set(false);
      editorErr.set("");
    });
  }

  function showIndexView() {
    mobileEditorVisible.set(false);
    // A phone's contact slides out as it was, its edit dropped once it has gone.
    void panes.settled().then(() => {
      if (!untracked(mobileEditorVisible)) stopEdit();
    });
  }

  function clearSelection() {
    stopEdit();
    batch(() => {
      selectedContactID.set("");
      mobileEditorVisible.set(false);
    });
  }

  /** Closes the panel; the card it showed stays where the keys stand. */
  function closePanel() {
    stopEdit();
    selectedContactID.set("");
  }

  function selectContact(item: Contact) {
    const id = contactID(item);
    if (!id) return;
    highlightID.set(id);
    if (id !== untracked(selectedContactID)) {
      stopEdit();
      selectedContactID.set(id);
    }
    if (untracked(isMobile)) mobileEditorVisible.set(true);
  }

  async function load() {
    err.set("");
    try {
      await store.load({ force: true });
      if (untracked(selectedContactID) && !untracked(selectedContact)) clearSelection();
    } catch (e: any) {
      err.set(e?.message || t("msg_load_failed"));
    }
  }

  async function startEdit() {
    const id = contactID(untracked(selectedContact));
    if (!id || untracked(editorLoading)) return;
    batch(() => {
      editingContactID.set(id);
      editorLoading.set(true);
      editorErr.set("");
      editorYAML.set("");
      loadedEditorYAML.set("");
    });
    try {
      const data = await runtimeApiFetch(`/contacts/item?contact_id=${encodeURIComponent(id)}`);
      if (untracked(editingContactID) !== id) return;
      const yaml = String(data?.yaml || "").trim();
      batch(() => {
        editorYAML.set(yaml);
        loadedEditorYAML.set(yaml);
      });
    } catch (e: any) {
      if (untracked(editingContactID) === id) editorErr.set(e?.message || t("msg_load_failed"));
    } finally {
      if (untracked(editingContactID) === id) editorLoading.set(false);
    }
  }

  async function saveEdit() {
    const id = untracked(editingContactID).trim();
    if (!id || untracked(saveDisabled)) return;
    batch(() => {
      editorSaving.set(true);
      editorErr.set("");
    });
    try {
      await runtimeApiFetch("/contacts/item", { method: "PUT", body: { contact_id: id, yaml: untracked(editorYAML) } });
      await load();
      if (untracked(selectedContactID) === id) stopEdit();
      notice.success(t("msg_save_success"));
    } catch (e: any) {
      notice.error(e?.message || t("msg_save_failed"));
    } finally {
      editorSaving.set(false);
    }
  }

  // setOwner marks the contact as one of the owner's own accounts, or unmarks it.
  async function setOwner(owner: boolean) {
    const id = contactID(untracked(selectedContact));
    if (!id || untracked(ownerSaving)) return;
    ownerSaving.set(true);
    try {
      await runtimeApiFetch("/contacts/item", { method: "PATCH", body: { contact_id: id, owner: Boolean(owner) } });
      await load();
      notice.success(t("msg_save_success"));
    } catch (e: any) {
      ownerSwitchKey.update((key) => key + 1);
      notice.error(e?.message || t("msg_save_failed"));
    } finally {
      ownerSaving.set(false);
    }
  }

  async function copyContactValue(raw: unknown) {
    const value = String(raw || "").trim();
    if (!value) return;
    try {
      await copyText(value);
      notice.success(t("contacts_copy_success"));
    } catch (e: any) {
      console.warn("copy:", e?.message);
      notice.error(t("contacts_copy_failed"));
    }
  }

  function confirmDelete() {
    const contact = untracked(selectedContact);
    if (!contact) return;
    batch(() => {
      deleteTarget.set(contact);
      deleteDialogOpen.set(true);
    });
  }

  function closeDeleteDialog() {
    batch(() => {
      deleteDialogOpen.set(false);
      deleteTarget.set(null);
    });
  }

  async function deleteContact() {
    if (untracked(deleting)) return;
    const id = contactID(untracked(deleteTarget));
    if (!id) {
      closeDeleteDialog();
      return;
    }
    batch(() => {
      deleting.set(true);
      deleteDialogOpen.set(false);
    });
    try {
      await runtimeApiFetch(`/contacts/item?contact_id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (untracked(selectedContactID) === id) clearSelection();
      await load();
      notice.success(t("msg_delete_success"));
    } catch (e: any) {
      notice.error(e?.message || t("msg_delete_failed"));
    } finally {
      batch(() => {
        deleting.set(false);
        deleteTarget.set(null);
      });
    }
  }

  function openSend() {
    const contact = untracked(selectedContact);
    if (!contact) return;
    batch(() => {
      sendTarget.set(contact);
      sendText.set("");
      sendErr.set("");
      sendOpen.set(true);
    });
  }

  function closeSend() {
    if (!untracked(sendBusy)) sendOpen.set(false);
  }

  // The message goes to the agent as a task in a new topic, which opens: the agent sends it with
  // contacts_send as written, and the topic shows how that went.
  async function sendMessage() {
    const contact = untracked(sendTarget);
    const message = untracked(sendText).trim();
    if (!contact || !message || untracked(sendBusy)) return;
    const endpointRef = endpointState.selectedRef;
    batch(() => {
      sendBusy.set(true);
      sendErr.set("");
    });
    try {
      const task = t("contacts_send_task", { name: displayName(contact), id: contactID(contact), message });
      const submitted = await runtimeApiFetchForEndpoint(endpointRef, "/tasks", { method: "POST", body: { task } });
      const topicID = String(submitted?.topic_id || "").trim();
      sendOpen.set(false);
      await navigate(endpointRoutePath(endpointRef, topicID ? `/chat/${encodeURIComponent(topicID)}` : "/chat"));
    } catch (e: any) {
      sendErr.set(e?.message || t("contacts_send_failed"));
    } finally {
      sendBusy.set(false);
    }
  }

  // The agent: the page is rebuilt for another one, so this is the first load, which the cards
  // rise into.
  effect(() => {
    void endpointState.selectedRef;
    untracked(() => {
      clearSelection();
      closeDeleteDialog();
      places.clear();
      highlightID.set("");
      libraryMotion.set("cascade");
      void load().finally(() => arm("cascade", 700));
    });
  });

  const contactMenu = () => [
    { id: "delete", label: t("action_delete"), disabled: deleting(), onSelect: confirmDelete },
  ];

  /* ---------- the grid ---------- */

  const listWidth = signal(0);
  const geometry = computed<LibraryGeometry>(() => {
    const phone = isMobile();
    const pad = phone ? gutterX() : 16;
    const gap = phone ? CARD_GAP.phone : CARD_GAP.desktop;
    const least = phone ? CARD_MIN.phone : CARD_MIN.desktop;
    const inner = Math.max(0, listWidth() - 2 * pad);
    const columns = Math.max(1, Math.floor((inner + gap) / (least + gap)));
    return { columns, cell: (inner - gap * (columns - 1)) / columns, pad, gap };
  });

  /* ---------- the selection (desktops) ---------- */

  // One highlight over the cards (they are opaque paper, so it cannot lie behind them as it does
  // behind the column lists' rows), placed from the grid's arithmetic since the list is virtualized,
  // and moved up with the list's scroll natively.
  const selection = createSlidingSelection(() => (isMobile() ? null : highlightID() || null));
  const headerHeight = signal(0);
  const scrollValue = createAnimatedValue(0);
  const scrollShift = scrollValue.interpolate({ inputRange: [0, 1], outputRange: [0, -1], extrapolate: "extend" });
  /** Where row `row` starts in the list's content: under its header, and the row gap the list
   *  keeps between the header and the first row as between rows. */
  const rowTop = (row: number, grid: LibraryGeometry, header: number) => header + grid.gap + row * (CARD_HEIGHT + grid.gap);
  let placed: { id: string; row: number } | null = null;
  effect(() => {
    const id = isMobile() ? "" : highlightID();
    const grid = geometry();
    const shown = filteredItems();
    const top = headerHeight();
    const loading = store.loading;
    untracked(() => {
      if (!id || loading) return;
      const index = shown.findIndex((item) => contactID(item) === id);
      if (index < 0) {
        placed = null;
        selection.forget(id);
        return;
      }
      const place = cardPlace(index, grid);
      const box = { x: place.x, y: rowTop(place.row, grid, top), w: grid.cell, h: CARD_HEIGHT };
      // The grid making room: a card that stays in its row slides along it (ContactCard), and the
      // highlight glides with it; one that changes rows fades in there, and the highlight is there.
      const follow = libraryMotion() === "glide" && placed?.id === id && placed.row === place.row ? motionMs(300) : 0;
      placed = { id, row: place.row };
      selection.place(id, box, follow);
    });
  });

  /* ---------- keys (desktops) ---------- */

  let list: ListRef | undefined;
  const scrollY = signal(0);
  const viewHeight = signal(0);
  /** Scrolls card `index` into view when its row is out of it. */
  function reveal(index: number) {
    const row = Math.floor(index / untracked(geometry).columns);
    const top = rowTop(row, untracked(geometry), untracked(headerHeight));
    if (top < untracked(scrollY)) list?.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset: 6 });
    else if (top + CARD_HEIGHT > untracked(scrollY) + untracked(viewHeight)) list?.scrollToIndex({ index, animated: true, viewPosition: 1, viewOffset: -8 });
  }
  // Whether the keys walk the grid: from the first arrow until a card is pressed or opened with
  // Enter. Only then does Enter belong to the library; otherwise it stays the focused control's.
  const walking = signal(false);
  function step(by: (columns: number) => number) {
    walking.set(true);
    const shown = untracked(filteredItems);
    if (!shown.length) return;
    const at = shown.findIndex((item) => contactID(item) === untracked(highlightID));
    const next = at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + by(untracked(geometry).columns)));
    const item = shown[next];
    highlightID.set(contactID(item));
    reveal(next);
    if (untracked(selectedContactID)) selectContact(item);
  }
  // Bound only while no menu or dialog is up (they keep their own keys) and no field has the focus.
  effect(() => {
    if (isMobile() || popupOpen()) return;
    cleanup(
      keymap.bind(
        {
          left: () => step(() => -1),
          right: () => step(() => 1),
          up: () => step((columns) => -columns),
          down: () => step((columns) => columns),
        },
        { when: "notEditing", repeat: true },
      ),
    );
    cleanup(
      keymap.bind(
        "escape",
        () => {
          if (untracked(selectedContactID)) closePanel();
        },
        { when: "notEditing", passThrough: true },
      ),
    );
    if (!walking()) return;
    cleanup(
      keymap.bind(
        "enter",
        () => {
          walking.set(false);
          const item = untracked(items).find((entry) => contactID(entry) === untracked(highlightID));
          if (item) selectContact(item);
        },
        { when: "notEditing" },
      ),
    );
  });

  /* ---------- the library ---------- */

  const pull = createPullSearch({
    query: () => filterText(),
    revealed: filterRevealed,
    label: t("contacts_filter_placeholder"),
  });
  const filterField = () => (
    <IndexSearch
      value={filterText()}
      onChange={(value) => filterText.set(value)}
      placeholder={t("contacts_filter_placeholder")}
      mobile={isMobile()}
      testID="contacts-filter"
    />
  );
  // The library's list, one on a phone and a desktop, always there, so the filter (a pull reaches it
  // on a touch phone) can be used while it loads, fails or is empty too. A virtualized List of
  // `numColumns` cards a row: the cards are recycled cells, so each draws its own selection, and
  // `places` remembers where each was for the library's motion.
  //
  // Its `empty` view is an element made here, not a function: nsh 0.4.0 never disposes the scope a
  // function `empty` slot renders in, so each list that went away (every Contacts page left, every
  // contact opened on the phone) kept one, subscribed to the store and re-rendering its loading
  // blocks into the dead list on every load, until the app hung for good: on the 10th Contacts /
  // TODO round trip headless, after 14 in the Android report. Made in this component, it goes with
  // the list (tests/contacts-todo-switch.test.tsx, tests/list-empty-slot.test.tsx). The loading
  // blocks and the note are both always in it, one of them hidden: an `If` there stopped switching
  // once the list had hidden the element and shown it again, so a reload that left the list empty
  // (the last contact deleted) kept the blocks for good (tests/contacts-empty-reload.test.tsx).
  function Library() {
    const empty = (
      <View>
        <View class={store.loading ? "flex-row flex-wrap" : "hidden"} style={{ paddingLeft: geometry().pad, paddingRight: geometry().pad, gap: geometry().gap }}>
          <Blocks count={isMobile() ? 2 : 4} height={CARD_HEIGHT} class="flex-1" />
        </View>
        <View class={store.loading ? "hidden" : ""}>
          <Note
            text={items().length === 0 ? t("contacts_empty") : t("contacts_empty_filtered")}
            class="mt-1 leading-normal"
            testID="contacts-empty"
          />
        </View>
      </View>
    );
    return (
      <View class="relative flex-1">
      <List
        ref={(node: ListRef) => (list = node)}
        footer={MobileBarSpacer}
        header={() => (
          <View onLayout={({ bounds }) => headerHeight.set(bounds.size.height)}>
            <If when={pull.shown()}>{filterField()}</If>
            <If when={!store.loading && err()}>
              <InlineNotice type="error" text={err()} class="mx-4 mt-2" testID="contacts-error" />
            </If>
            <View class="h-1.5" />
          </View>
        )}
        empty={empty}
        each={store.loading ? [] : filteredItems()}
        keyExtractor={(item) => contactID(item)}
        numColumns={geometry().columns}
        estimatedItemSize={CARD_HEIGHT}
        contentStyle={{ paddingLeft: geometry().pad, paddingRight: geometry().pad, paddingBottom: 24, rowGap: geometry().gap, columnGap: geometry().gap }}
        class="flex-1"
        scrollbar={SCROLLBAR}
        onLayout={({ bounds }) => {
          listWidth.set(bounds.size.width);
          viewHeight.set(bounds.size.height);
        }}
        onScroll={(event) => scrollY.set(event.offset.y)}
        scrollValue={scrollValue}
        scrollEventThrottle={50}
        refreshIndicator={pull.indicator}
        refreshing={pull.refreshing()}
        onRefresh={pull.onRefresh}
        onScrollDragStart={pull.onDragStart}
        accessibilityActions={pull.actions()}
        onAccessibilityAction={pull.onAction}
        testID="contacts-list"
      >
        {(item, index) => (
          <ContactCard
            item={item()}
            index={index()}
            geometry={geometry()}
            motion={libraryMotion}
            places={places}
            selected={!isMobile() && contactID(item()) === highlightID()}
            leaving={leavingIDs().has(contactID(item()))}
            onPress={() => {
              walking.set(false);
              selectContact(item());
            }}
          />
        )}
      </List>
      <View class="absolute inset-0 overflow-hidden" accessibilityElementsHidden style={{ pointerEvents: "none" }}>
        <View class="absolute left-0 top-0" style={{ transform: [{ translateY: scrollShift }] }}>
          <selection.Highlight class="rounded-[16px] border border-[#426f9e61] bg-selection" testID="contacts-selection" />
        </View>
      </View>
      </View>
    );
  }

  /* ---------- the contact: the panel's body on a desktop, the second level on a phone ---------- */

  const sectionPad = () => (isMobile() ? gutterX() : 22);

  function ContactBody(props: { contact: Contact }) {
    const contact = () => props.contact;
    return (
      <View testID="contact-detail" class={isMobile() ? "" : "flex-1"}>
        <View
          class="relative flex-row items-center gap-[18px] border-b border-line-soft"
          style={{ paddingLeft: sectionPad(), paddingRight: sectionPad(), paddingTop: 22, paddingBottom: 18 }}
        >
          <KindAvatar item={contact()} size={PANEL_AVATAR} resolve={contactID(contact())} />
          <View class="flex-1 gap-[5px]" style={{ minWidth: 0, paddingRight: isMobile() ? 72 : 96 }} accessibilityLabel={kindText(contact())}>
            <View selectable style={{ minWidth: 0 }}>
              <FadeText role="header" text={displayName(contact())} fade={26} class="text-[22px] font-bold leading-[27px] tracking-[-0.02em] text-foreground" />
            </View>
            <Text class="font-mono text-[10.5px] uppercase leading-[15px] tracking-[0.14em] text-muted-foreground">
              {`${kindText(contact())} · ${channelLabel(contact().channel)}`}
            </Text>
            <If when={!editing()}>
              <View class="mt-1.5 flex-row">
                <Button
                  variant="outlined"
                  size="xs"
                  icon="PhPaperPlaneTilt"
                  label={t("contacts_action_send_message")}
                  onPress={openSend}
                  testID="contact-send"
                />
              </View>
            </If>
          </View>
          <View class="absolute right-2.5 top-2.5 flex-row items-center gap-0.5">
            <If when={!editing()}>
              <Button variant="plain" size="xs" iconOnly title={t("contacts_action_edit_yaml")} onPress={() => void startEdit()} testID="contact-edit">
                <Icon name="PhPencilSimple" size={15} color="subtle" />
              </Button>
              <DropdownMenu items={contactMenu()} disabled={deleting()} trigger={<MoreTrigger label={t("todo_action_more")} testID="contact-actions" />} />
            </If>
            <If when={!isMobile()}>
              <CircleButton
                title={t("action_close")}
                icon="PhX"
                iconColor="danger"
                size="sm"
                variant="close"
                onPress={closePanel}
                class="ml-1"
                testID="contact-close"
              />
            </If>
          </View>
        </View>

        <If
          when={editing()}
          else={
            <View>
              <If when={!isAgent(contact())}>
                {/* One of the owner's own accounts: the switch, then what it means, over a hairline. */}
                <Rise order={0} class="border-b border-line-soft py-4" testID="contact-owner-row">
                  <View class="flex-row items-start gap-3" style={{ paddingLeft: sectionPad(), paddingRight: sectionPad() }}>
                    <Each of={[ownerSwitchKey()]}>
                      {() => (
                        <View class="pt-0.5">
                          <SwitchOnly
                            checked={Boolean(contact().owner)}
                            disabled={ownerSaving()}
                            label={t("contacts_owner_label")}
                            onChange={(value) => void setOwner(value)}
                            testID="contact-owner"
                          />
                        </View>
                      )}
                    </Each>
                    <View class="flex-1 gap-0.5">
                      <Text class="text-sm font-medium leading-normal text-foreground">{t("contacts_owner_label")}</Text>
                      <Text class="text-xs leading-normal text-muted-foreground">{t("contacts_owner_hint")}</Text>
                    </View>
                  </View>
                </Rise>
              </If>

              <Rise order={1} class="gap-1.5 pb-1.5 pt-[18px]">
                <View style={{ paddingLeft: sectionPad(), paddingRight: sectionPad() }}>
                  <SectionHead text={t("contacts_section_connections")} />
                  <Each of={connectionsOf(contact())} key={(connection) => connection.key}>
                    {(connection) => (
                      <View class="min-h-[58px] flex-row items-center gap-3 border-b border-line-soft py-2">
                        <View class="w-[22px] items-center">
                          <ChannelMark channel={connection().channelKey} size={20} />
                        </View>
                        <View class="flex-1 gap-px" style={{ minWidth: 0 }}>
                          <Text class="text-[13.5px] font-bold leading-[19px] text-foreground">{connection().channel}</Text>
                          <View selectable>
                            <FadeText text={connection().full} fade={24} class="font-mono text-xs leading-[18px] text-muted-foreground" />
                          </View>
                        </View>
                        <View class="w-8 items-center">
                          <If when={connection().copyable}>
                            <CopyButton onPress={() => void copyContactValue(connection().full)} testID={`contact-copy:${connection().key}`} />
                          </If>
                        </View>
                      </View>
                    )}
                  </Each>
                  <View class="min-h-[58px] flex-row items-center gap-3 py-2">
                    <View class="w-[22px] items-center">
                      <Icon name="PhFingerprint" size={18} color="muted-foreground" />
                    </View>
                    <View class="flex-1 gap-px" style={{ minWidth: 0 }}>
                      <Text class="text-xs leading-[17px] text-muted-foreground">{t("contacts_field_contact_id")}</Text>
                      <View selectable>
                        <FadeText text={contactID(contact())} fade={24} class="font-mono text-xs leading-[18px] text-muted-foreground" />
                      </View>
                    </View>
                    <View class="w-8 items-center">
                      <CopyButton onPress={() => void copyContactValue(contactID(contact()))} testID="contact-copy-id" />
                    </View>
                  </View>
                </View>
              </Rise>

              <Rise order={2} class="pb-1.5 pt-[18px]">
                <View class="gap-2" style={{ paddingLeft: sectionPad(), paddingRight: sectionPad() }}>
                  <SectionHead text={t("contacts_section_memories")} />
                  <If when={memoriesLoading()}>
                    <Blocks count={1} height={48} />
                  </If>
                  <If when={!memoriesLoading() && !selectedMemories().length}>
                    <Note text={t("contacts_memories_empty")} />
                  </If>
                  <If when={!memoriesLoading() && selectedMemories().length > 0}>
                    <View testID="contact-memories">
                      <Each of={selectedMemories()} key={(memory) => memory.id}>
                        {(memory, index) => (
                          <View selectable class={`gap-0.5 py-[9px] ${index() === 0 ? "" : "border-t border-line-soft"}`}>
                            <Text class="text-[12.5px] font-bold leading-[18px] text-foreground">{memory().description ?? ""}</Text>
                            <Text class="text-[12.5px] leading-[19px] text-subtle">{memory().body ?? ""}</Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  </If>
                  <View class="-ml-3 self-start">
                    <Button variant="plain" size="sm" label={t("contacts_memories_open")} onPress={openMemories} testID="contact-open-memories" />
                  </View>
                </View>
              </Rise>

              <Rise order={3} class="pb-5 pt-[18px]">
                <View class="gap-2" style={{ paddingLeft: sectionPad(), paddingRight: sectionPad() }}>
                  <SectionHead text={t("contacts_section_activity")} />
                  <View>
                    <ActivityItem
                      icon="PhClockCounterClockwise"
                      label={t("contacts_field_last_interaction")}
                      value={contact().last_interaction_at ? relativeTime(contact().last_interaction_at) : t("contacts_activity_none")}
                      time={contact().last_interaction_at ? formatShortTime(contact().last_interaction_at) : ""}
                    />
                    <If when={contact().cooldown_until}>
                      <ActivityItem
                        icon="PhTimer"
                        label={t("contacts_field_cooldown")}
                        value={relativeTime(contact().cooldown_until)}
                        time={formatShortTime(contact().cooldown_until)}
                        divided
                      />
                    </If>
                  </View>
                </View>
              </Rise>
            </View>
          }
        >
          <View class="gap-3 py-4" testID="contact-editor" style={{ paddingLeft: sectionPad(), paddingRight: sectionPad() }}>
            <If when={editorLoading()} else={
              <View class="gap-3">
                <If when={editorErr()}>
                  <InlineNotice type="error" text={editorErr()} testID="contact-editor-error" />
                </If>
                <TextField
                  value={editorYAML()}
                  onChange={(value) => editorYAML.set(value)}
                  multiline
                  rows={22}
                  mono
                  disabled={editorSaving()}
                  accessibilityLabel={t("contacts_editor_hint")}
                  testID="contact-yaml"
                />
                <Note text={t("contacts_editor_hint")} class="leading-normal" />
                <View class="flex-row justify-end gap-2">
                  <Button variant="outlined" size="sm" label={t("action_cancel")} disabled={editorSaving()} onPress={stopEdit} testID="contact-edit-cancel" />
                  <Button
                    variant="primary"
                    size="sm"
                    label={t("action_save")}
                    loading={editorSaving()}
                    disabled={saveDisabled()}
                    onPress={() => void saveEdit()}
                    testID="contact-edit-save"
                  />
                </View>
              </View>
            }>
              <Blocks count={1} height={360} />
            </If>
          </View>
        </If>
      </View>
    );
  }

  return (
    <Page hideBar scroll={false} testID="contacts-page">
      <View class="relative flex-1 flex-row">
        <If when={panes.shown(0, showIndexPane())}>
          <IndexColumn
            title={t("contacts_title")}
            fill
            style={panes.style(0)}
            hidden={panes.hidden(0)}
            scroll={false}
            testID="contacts-index"
          >
            <Library />
          </IndexColumn>
        </If>

        {/* The panel: floating paper with the popups' corners at the right of the library, 12pt off
            it and the window's edges. While it goes out it leaves the row, over the library. */}
        <If when={isMobile() ? null : panelContact()}>
          {(contact) => (
            <View
              class={panelLeaving() ? "absolute bottom-0 right-0 top-0" : ""}
              accessibilityLabel={displayName(contact())}
              style={{ width: PANEL_WIDTH + PANEL_INSET, paddingTop: PANEL_INSET, paddingBottom: PANEL_INSET, paddingRight: PANEL_INSET, ...panelMotion.style }}
            >
              <View
                class="flex-1 overflow-hidden border border-line-faint bg-dialog"
                style={{ borderRadius: POPUP_RADIUS, boxShadow: platform.os === "android" ? undefined : PANEL_SHADOW }}
              >
                <Scroll class="flex-1" scrollbar={SCROLLBAR} contentClass="grow">
                  <View class="grow" style={bodyMotion.style}>
                    <ContactBody contact={contact()} />
                  </View>
                </Scroll>
              </View>
            </View>
          )}
        </If>

        {/* The phone's contact: on the frame's paper, so the library does not show through it as it
            slides in over it. */}
        <If when={panes.shown(1, showEditorPane())}>
          <View
            class="flex-1 bg-background"
            style={panes.style(1)}
            accessibilityElementsHidden={panes.hidden(1) || undefined}
            importantForAccessibility={panes.hidden(1) ? "no-hide-descendants" : undefined}
          >
            <MobileBar title={heldBarTitle()} backLabel={t("contacts_title")} onBack={panes.hidden(1) ? undefined : showIndexView} />
            <Scroll class="flex-1" scrollbar={SCROLLBAR} contentClass="grow">
              <If when={shownContact()}>{(contact) => <ContactBody contact={contact()} />}</If>
              <MobileBarSpacer testID="contact-detail-bar-room" />
            </Scroll>
          </View>
        </If>
      </View>

      <Modal
        open={sendOpen()}
        onClose={closeSend}
        title={t("contacts_send_title", { name: displayName(sendTarget()) })}
        closeLabel={t("action_close")}
        testID="contact-send-dialog"
        footer={
          <>
            <Button variant="outlined" size="md" label={t("action_cancel")} disabled={sendBusy()} onPress={closeSend} testID="contact-send-cancel" />
            <Button
              variant="primary"
              size="md"
              icon="PhPaperPlaneTilt"
              label={t("contacts_send_submit")}
              loading={sendBusy()}
              disabled={!sendText().trim() || sendBusy()}
              onPress={() => void sendMessage()}
              testID="contact-send-submit"
            />
          </>
        }
      >
        <If when={sendErr()}>
          <InlineNotice type="error" text={sendErr()} testID="contact-send-error" />
        </If>
        <TextField
          value={sendText()}
          onChange={(value) => sendText.set(value)}
          multiline
          rows={5}
          autoFocus
          disabled={sendBusy()}
          placeholder={t("contacts_send_placeholder")}
          accessibilityLabel={t("contacts_send_placeholder")}
          testID="contact-send-text"
        />
        <Note text={t("contacts_send_hint")} class="leading-normal" />
      </Modal>

      <MessageDialog
        open={deleteDialogOpen()}
        onClose={closeDeleteDialog}
        icon="PhTrash"
        tone="danger"
        title={t("action_delete")}
        text={deleteDialogText()}
        testID="contacts-delete-dialog"
        actions={[
          { id: "cancel", label: t("action_cancel"), variant: "outlined", onPress: closeDeleteDialog },
          { id: "delete", label: t("action_delete"), variant: "danger", onPress: () => void deleteContact() },
        ]}
      />
    </Page>
  );
}
