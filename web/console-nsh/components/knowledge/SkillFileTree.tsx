// A skill's folder as a read-only tree (web/console/src/components/SkillFileTree.js). Folders are
// read one level at a time when opened; files are chosen with onSelect and previewed by the page.
// Links and special files are listed but cannot be opened. Another skill or agent starts over, and
// answers for the old one are dropped.
import { effect, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { endpointApiFetch, formatBytes } from "../../lib/core/context.js";
import {
  createRequestGuard,
  isSelectableSkillEntry,
  normalizeSkillDirListing,
  skillDirURL,
  skillPathErrorKind,
  skillTreeRows,
} from "../../lib/core/skill-files.js";
import { Icon } from "../ui";
import { t } from "./parts";

type Entry = { name: string; path: string; kind: "dir" | "file" | "symlink" | "other"; size: number };
type TreeNode = { status: "loading" | "ready" | "error"; entries?: Entry[]; capped?: boolean; error?: string; message?: string };
type Row = {
  type: "entry" | "loading" | "error" | "empty" | "capped";
  key: string;
  path: string;
  depth: number;
  entry?: Entry;
  open?: boolean;
  error?: string;
  count?: number;
};

export interface SkillFileTreeProps {
  endpointRef: string;
  skillId: string;
  selectedPath: string;
  disabled?: boolean;
  /** The catalog's flat list, shown when the agent cannot browse folders. */
  fallbackFiles: { path: string; size?: number }[];
  onSelect?: (path: string) => void;
}

export function SkillFileTree(props: SkillFileTreeProps) {
  const nodes = signal<Record<string, TreeNode>>({});
  const expanded = signal<Set<string>>(new Set());
  const unsupported = signal(false);
  const guard = createRequestGuard();
  const rows = () => skillTreeRows(nodes(), expanded()) as Row[];

  function setNode(path: string, node: TreeNode) {
    nodes.update((all) => ({ ...all, [path]: node }));
  }

  async function loadDir(path: string) {
    const ticket = guard.peek();
    const endpointRef = untracked(() => props.endpointRef);
    const id = untracked(() => props.skillId);
    if (!id) return;
    setNode(path, { status: "loading" });
    try {
      const data = await endpointApiFetch(endpointRef, skillDirURL(id, path));
      if (!guard.current(ticket)) return;
      const listing = normalizeSkillDirListing(data, path);
      setNode(path, { status: "ready", entries: listing.entries as Entry[], capped: listing.capped });
    } catch (error) {
      if (!guard.current(ticket)) return;
      const kind = skillPathErrorKind(error);
      if (path === "" && kind === "unsupported") unsupported.set(true);
      setNode(path, { status: "error", error: kind, message: String((error as Error)?.message || "") });
    }
  }

  effect(() => {
    void props.endpointRef;
    void props.skillId;
    untracked(() => {
      guard.next();
      nodes.set({});
      expanded.set(new Set());
      unsupported.set(false);
      void loadDir("");
    });
  });

  function toggle(entry: Entry) {
    const next = new Set(expanded());
    if (next.has(entry.path)) {
      next.delete(entry.path);
    } else {
      next.add(entry.path);
      const node = nodes()[entry.path];
      if (!node || node.status === "error") void loadDir(entry.path);
    }
    expanded.set(next);
  }

  function choose(entry: Entry) {
    if (!props.disabled && isSelectableSkillEntry(entry)) props.onSelect?.(entry.path);
  }

  function dirErrorText(row: Row) {
    switch (row.error) {
      case "missing":
        return t("skills_files_dir_missing");
      case "denied":
        return t("skills_files_dir_denied");
      case "symlink":
        return t("skills_files_link");
      default:
        return t("skills_files_dir_failed");
    }
  }

  const indent = (row: Row) => ({ paddingLeft: 6 + row.depth * 16 });

  return (
    <View testID="skill-file-tree" class="gap-0.5 rounded-(--radius) border border-line-faint bg-paper p-1.5">
      <If
        when={unsupported()}
        else={
          <View accessibilityLabel={t("skills_fact_files")} class="gap-px">
            <Each of={rows()} key={(row) => row.key}>
              {(row) => (
                <View style={indent(row())}>
                  <If when={row().type === "entry" && row().entry?.kind === "dir"}>
                    <BaseButton
                      onPress={() => toggle(row().entry!)}
                      accessibilityLabel={row().entry?.name}
                      testID={`skill-file:${row().path}`}
                      class="flex-row items-center gap-1.5 rounded-(--radius) px-1.5 py-1 hover:bg-hover"
                    >
                      <Icon name={row().open ? "PhCaretDown" : "PhCaretRight"} size={12} color="muted-foreground" />
                      <Icon name={row().open ? "PhFolderOpen" : "PhFolder"} size={15} color="subtle" />
                      <Text class="flex-1 text-sm text-foreground line-clamp-1">{row().entry?.name}</Text>
                    </BaseButton>
                  </If>
                  <If when={row().type === "entry" && row().entry?.kind === "file"}>
                    <BaseButton
                      onPress={() => choose(row().entry!)}
                      disabled={props.disabled}
                      selected={row().path === props.selectedPath}
                      accessibilityLabel={row().entry?.name}
                      testID={`skill-file:${row().path}`}
                      class={`flex-row items-center gap-1.5 rounded-(--radius) px-1.5 py-1 hover:bg-hover disabled:opacity-45 ${
                        row().path === props.selectedPath ? "bg-selection" : ""
                      }`}
                    >
                      <View class="w-3" />
                      <Icon name="PhFileText" size={15} color={row().path === props.selectedPath ? "blue" : "subtle"} />
                      <Text class="flex-1 text-sm text-foreground line-clamp-1">{row().entry?.name}</Text>
                      <Text class="font-mono text-xs text-muted-foreground">{formatBytes(row().entry?.size ?? 0)}</Text>
                    </BaseButton>
                  </If>
                  <If when={row().type === "entry" && row().entry?.kind !== "dir" && row().entry?.kind !== "file"}>
                    <View class="flex-row items-center gap-1.5 px-1.5 py-1 opacity-70">
                      <View class="w-3" />
                      <Icon name={row().entry?.kind === "symlink" ? "PhLink" : "PhFile"} size={15} color="muted-foreground" />
                      <Text class="flex-1 text-sm text-subtle line-clamp-1">{row().entry?.name}</Text>
                      <Text class="font-mono text-xs text-muted-foreground">
                        {row().entry?.kind === "symlink" ? t("skills_files_link") : t("skills_files_special")}
                      </Text>
                    </View>
                  </If>
                  <If when={row().type === "loading"}>
                    <Text class="px-1.5 py-1 text-xs text-muted-foreground">{t("skills_files_loading")}</Text>
                  </If>
                  <If when={row().type === "empty"}>
                    <Text class="px-1.5 py-1 text-xs text-muted-foreground">{t("skills_files_empty_dir")}</Text>
                  </If>
                  <If when={row().type === "capped"}>
                    <Text class="px-1.5 py-1 text-xs text-muted-foreground">{t("skills_files_capped", { count: row().count })}</Text>
                  </If>
                  <If when={row().type === "error"}>
                    <View role="alert" class="flex-row flex-wrap items-center gap-2 px-1.5 py-1">
                      <Text class="text-xs text-danger">{dirErrorText(row())}</Text>
                      <If when={row().error === "failed"}>
                        <Text role="button" onPress={() => void loadDir(row().path)} class="text-xs text-blue underline">
                          {t("skills_files_retry")}
                        </Text>
                      </If>
                    </View>
                  </If>
                </View>
              )}
            </Each>
          </View>
        }
      >
        <View class="gap-1 p-1">
          <Text class="text-xs text-muted-foreground">{t("skills_files_unsupported")}</Text>
          <Each of={props.fallbackFiles} key={(file) => file.path}>
            {(file) => (
              <View class="flex-row items-center justify-between gap-3">
                <Text class="flex-1 font-mono text-xs text-foreground line-clamp-1">{file().path}</Text>
                <Text class="font-mono text-xs text-muted-foreground">{formatBytes(file().size ?? 0)}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
