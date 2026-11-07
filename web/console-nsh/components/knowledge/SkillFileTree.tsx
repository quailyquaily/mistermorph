// A skill's folder as a read-only tree (web/console/src/components/SkillFileTree.js). Folders are
// read one level at a time when opened; files are chosen with onSelect and previewed by the page.
// Links and special files are listed but cannot be opened. Another skill or agent starts over, and
// answers for the old one are dropped. Rows indent 16pt a level; a folder's caret turns as it opens.
import { effect, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
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
import { SCROLLBAR } from "../motion";
import { Icon } from "../ui";
import { ROW_HOVER, ROW_TRANSITION, t, TurnCaret } from "./parts";

// A row: caret 12 | icon 14 | mono name | size, padded 3/6, a hairline frame that shows on hover
// (soft) and on the open file (Vue: .skill-file-tree-item).
const ITEM = "flex-row items-center gap-1.5 rounded-(--radius) border border-transparent px-1.5 py-[3px]";

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

  const indent = (row: Row) => ({ paddingLeft: row.depth * 16 });
  // A status line (loading, empty, capped, an error) sits where the folder's entries would.
  const STATUS = "flex-row flex-wrap items-baseline gap-2 py-[3px] pl-8 pr-1.5";

  return (
    <View testID="skill-file-tree" class="mt-2">
      <If
        when={unsupported()}
        else={
          <Scroll style={{ maxHeight: Math.min(420, windowSize().height * 0.48), flexGrow: 0 }} scrollbar={SCROLLBAR}>
            <View accessibilityLabel={t("skills_fact_files")} class="gap-px">
              <Each of={rows()} key={(row) => row.key}>
                {(row) => (
                  <View style={indent(row())}>
                    <If when={row().type === "entry" && row().entry?.kind === "dir"}>
                      <BaseButton
                        onPress={() => toggle(row().entry!)}
                        accessibilityLabel={row().entry?.name}
                        testID={`skill-file:${row().path}`}
                        class={`${ITEM} hover:border-line-soft/75 hover:bg-hover`}
                        style={ROW_TRANSITION}
                        hoverStyle={ROW_HOVER}
                      >
                        <TurnCaret open={Boolean(row().open)} turn={90} icon="PhCaretRight" />
                        <Icon name={row().open ? "PhFolderOpen" : "PhFolder"} size={14} color="muted-foreground" />
                        <Text class="flex-1 font-mono text-xs leading-normal text-subtle" style={{ numberOfLines: 1 }}>
                          {row().entry?.name}
                        </Text>
                      </BaseButton>
                    </If>
                    <If when={row().type === "entry" && row().entry?.kind === "file"}>
                      <BaseButton
                        onPress={() => choose(row().entry!)}
                        disabled={props.disabled}
                        selected={row().path === props.selectedPath}
                        accessibilityLabel={row().entry?.name}
                        testID={`skill-file:${row().path}`}
                        class={`${ITEM} disabled:opacity-60 ${
                          row().path === props.selectedPath ? "border-line bg-[#e1e9f2]" : "hover:border-line-soft/75 hover:bg-hover"
                        }`}
                        style={ROW_TRANSITION}
                        hoverStyle={ROW_HOVER}
                      >
                        <View class="w-3" />
                        <Icon name="PhFileText" size={14} color="muted-foreground" />
                        <Text
                          class={`flex-1 font-mono text-xs leading-normal ${row().path === props.selectedPath ? "text-foreground" : "text-subtle"}`}
                          style={{ numberOfLines: 1 }}
                        >
                          {row().entry?.name}
                        </Text>
                        <Text class="text-xs text-muted-foreground">{formatBytes(row().entry?.size ?? 0)}</Text>
                      </BaseButton>
                    </If>
                    <If when={row().type === "entry" && row().entry?.kind !== "dir" && row().entry?.kind !== "file"}>
                      <View class={ITEM}>
                        <View class="w-3" />
                        <Icon name={row().entry?.kind === "symlink" ? "PhLink" : "PhFile"} size={14} color="muted-foreground" />
                        <Text class="flex-1 font-mono text-xs leading-normal text-muted-foreground" style={{ numberOfLines: 1 }}>
                          {row().entry?.name}
                        </Text>
                        <Text class="text-xs text-muted-foreground">
                          {row().entry?.kind === "symlink" ? t("skills_files_link") : t("skills_files_special")}
                        </Text>
                      </View>
                    </If>
                    <If when={row().type === "loading"}>
                      <View class={STATUS}>
                        <Text class="text-xs text-muted-foreground">{t("skills_files_loading")}</Text>
                      </View>
                    </If>
                    <If when={row().type === "empty"}>
                      <View class={STATUS}>
                        <Text class="text-xs text-muted-foreground">{t("skills_files_empty_dir")}</Text>
                      </View>
                    </If>
                    <If when={row().type === "capped"}>
                      <View class={STATUS}>
                        <Text class="text-xs text-muted-foreground">{t("skills_files_capped", { count: row().count })}</Text>
                      </View>
                    </If>
                    <If when={row().type === "error"}>
                      <View role="alert" class={STATUS}>
                        <Text class="text-xs text-danger">{dirErrorText(row())}</Text>
                        <If when={row().error === "failed"}>
                          <Text role="button" onPress={() => void loadDir(row().path)} class="text-xs text-blue hover:underline">
                            {t("skills_files_retry")}
                          </Text>
                        </If>
                      </View>
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </Scroll>
        }
      >
        <View class="gap-0.5">
          <Text class="text-xs text-muted-foreground">{t("skills_files_unsupported")}</Text>
          <Each of={props.fallbackFiles} key={(file) => file.path}>
            {(file) => (
              <View class="flex-row items-center justify-between gap-3">
                <Text class="flex-1 font-mono text-xs text-foreground" style={{ numberOfLines: 1 }}>
                  {file().path}
                </Text>
                <Text class="text-xs text-muted-foreground">{formatBytes(file().size ?? 0)}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
