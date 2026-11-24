// The UI component gallery's inventory (/__ui-components): the console's reused UI components, by the
// file each is in. The gallery mounts one demo per component listed here (./demos, by `id`).
//
// A component belongs here when it is reused: it is exported, and at least two areas of the
// console use it (an area is a folder of `components/` or `pages/`; `settings-page` counts with
// `settings`). A component of the shared kit (`components/shared/`) is reusable by where it is:
// it belongs here once anything uses it. A page's own parts, a part of one feature, a whole page and the app's frame are not
// listed: look at them where they are used. `scripts/ui-components-inventory.test.mjs` reads the
// sources and fails when an entry names a component that is gone, is not exported or is no longer
// reused, and when the entries and the demos do not match one to one. It does not ask for every
// reused component to be listed: adding one here, with its demo, is a choice.

/**
 * @typedef {{ id: string, name: string, file: string, group: string }} GalleryEntry
 */

/** The gallery's sections, in order; `titleKey` (and `titleKey + "_note"`) are in lib/i18n. */
export const GALLERY_GROUPS = [
  { id: "controls", titleKey: "uig_group_controls" },
  { id: "feedback", titleKey: "uig_group_feedback" },
  { id: "overlays", titleKey: "uig_group_overlays" },
  { id: "layout", titleKey: "uig_group_layout" },
  { id: "frame", titleKey: "uig_group_frame" },
  { id: "motion", titleKey: "uig_group_motion" },
  { id: "chat", titleKey: "uig_group_chat" },
  { id: "composer", titleKey: "uig_group_composer" },
  { id: "rich", titleKey: "uig_group_rich" },
  { id: "knowledge", titleKey: "uig_group_knowledge" },
  { id: "settings", titleKey: "uig_group_settings" },
  { id: "forms", titleKey: "uig_group_forms" },
  { id: "observe", titleKey: "uig_group_observe" },
  { id: "contacts", titleKey: "uig_group_contacts" },
];

/** By file: the file's default section, and each listed component in it (with its own section where it differs). @type {Record<string, { group: string, items: Record<string, string | null> }>} */
const FILES = {
  "components/ui.tsx": {
    group: "controls",
    items: {
      Icon: null,
      StatusMark: "feedback",
      Spinner: "feedback",
      Kicker: "layout",
      Markdown: "rich",
      Tip: "overlays",
      TipButton: null,
      BusyBeam: "feedback",
      CircleButton: null,
      Button: null,
      TextField: null,
      Toggle: null,
      SelectField: null,
      DropdownMenu: "overlays",
      Divider: "layout",
      Section: "layout",
      Skeleton: "feedback",
      LoadingLine: "feedback",
      ProgressBar: "feedback",
      Tabs: null,
      DialogLayer: "overlays",
      Modal: "overlays",
      MessageDialog: "overlays",
      NoticeHost: "feedback",
      Page: "layout",
      PageBar: "layout",
      PageTitle: "layout",
      BackButton: null,
      SidePane: "overlays",
      Fab: null,
    },
  },
  "components/frame/AgentSwitcher.tsx": { group: "frame", items: { AgentSwitcher: null } },
  "components/motion/BorderBeam.tsx": { group: "motion", items: { BorderBeam: null } },
  "components/motion/Entrance.tsx": { group: "motion", items: { Entrance: null } },
  "components/motion/FadeText.tsx": { group: "motion", items: { FadeText: null } },
  "components/motion/PixelResolve.tsx": { group: "motion", items: { PixelResolve: null } },
  "components/motion/Sag.tsx": { group: "motion", items: { SagRule: null } },
  "components/motion/ScrollEdges.tsx": { group: "motion", items: { EdgeScroll: null } },
  "components/shared/CapsuleBar.tsx": { group: "controls", items: { CapsuleNav: null, CapsuleToolbar: null, CapsuleButton: null } },
  "components/shared/HeadTabs.tsx": { group: "controls", items: { HeadTabs: null } },
  "components/shared/ContactAvatar.tsx": { group: "contacts", items: { ContactAvatar: null } },
  "components/shared/CutoutAvatar.tsx": { group: "contacts", items: { CutoutAvatar: null } },
  "components/shared/DateField.tsx": { group: "controls", items: { DateField: null } },
  "components/shared/MarkdownEditor.tsx": { group: "rich", items: { MarkdownEditor: null } },
  "components/shared/PickerList.tsx": { group: "overlays", items: { PickerList: null } },
  "components/shared/PopoverPicker.tsx": { group: "overlays", items: { PopoverPicker: null } },
  "components/shared/RawJsonDialog.tsx": { group: "overlays", items: { RawJsonDialog: null } },
  "components/shared/RollingNumber.tsx": { group: "observe", items: { RollingNumber: null } },
  "components/chat/ChatComposer.tsx": { group: "composer", items: { ChatComposer: null } },
  "components/chat/ChatTerminal.tsx": { group: "rich", items: { ChatTerminal: null } },
  "components/chat/TodoJobBar.tsx": { group: "chat", items: { TodoJobBar: null } },
  "components/knowledge/parts.tsx": {
    group: "knowledge",
    items: {
      InlineNotice: null,
      Note: null,
      SearchField: null,
      IndexSearch: null,
      IndexColumn: null,
      IndexDivider: null,
      IndexRow: null,
      Blocks: null,
      DetailCard: null,
      MoreTrigger: null,
      MobileBar: null,
      SwitchOnly: null,
      TurnCaret: null,
    },
  },
  "components/observe/parts.tsx": { group: "observe", items: { ObserveSection: null, AuditBadge: null } },
  "components/settings/ConfigSettingsPanel.tsx": { group: "forms", items: { ConfigSettingsPanel: null } },
  "components/settings/DialogShell.tsx": { group: "overlays", items: { DialogShell: null, InlineNotice: "feedback" } },
  "components/settings/EnvManagedField.tsx": { group: "settings", items: { EnvManagedField: null } },
  "components/settings/ImageUploadField.tsx": { group: "settings", items: { ImageUploadField: null } },
  "components/settings/InferenceProviderPicker.tsx": { group: "settings", items: { InferenceProviderPicker: null } },
  "pages/chat/WorkspacePanel.tsx": { group: "chat", items: { WorkspaceSheet: null } },
  "pages/contacts/ContactCard.tsx": { group: "contacts", items: { KindAvatar: null } },
  "pages/setup/InlineNotice.tsx": { group: "feedback", items: { InlineNotice: null } },
};

/** @returns {GalleryEntry[]} */
function build() {
  /** @type {Record<string, number>} */
  const seen = {};
  for (const file of Object.values(FILES)) for (const name of Object.keys(file.items)) seen[name] = (seen[name] || 0) + 1;
  /** @type {GalleryEntry[]} */
  const entries = [];
  for (const [path, file] of Object.entries(FILES)) {
    const stem = path.split("/").slice(-2).join("/").replace(/\.tsx$/, "");
    for (const [name, group] of Object.entries(file.items)) {
      entries.push({
        // A name two files use is told apart by its file: `InlineNotice-knowledge-parts`.
        id: seen[name] > 1 ? `${name}-${stem.replace("/", "-")}` : name,
        name,
        file: path,
        group: group || file.group,
      });
    }
  }
  return entries;
}

/** Every listed component, in the order of the files above. */
export const GALLERY_ENTRIES = build();
