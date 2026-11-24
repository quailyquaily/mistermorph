// A test entry for tests/chat-skill-preview-layout.test.tsx: a reply's skill_install approval card
// (the real ChatHistoryItem around ChatSkillInstallPreview) with long values: a GitHub source whose
// link carries the whole commit, findings with a long title holding a URL and a long file path, a
// short finding, folded low findings, notes with long evidence, and (incomplete case) coverage gaps
// with long paths and notes beside a source whose commit shows after it. The buttons switch the
// case (`case-<name>`): `complete`, `incomplete`, `short`, `empty`, `expired`. Every fold starts
// open. The card's parts report where they lie (probeSkillInstallPreview), read out as JSON in
// `frames`, with the window width.
import { mount, signal, Text, View } from "nsh";
import { createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import { ChatHistoryItem, type ChatRowContext, type HistoryItem } from "../../components/chat/ChatHistoryItem";
import { probeSkillInstallPreview } from "../../components/chat/ChatSkillInstallPreview";
import { createReceivedFiles } from "../../components/chat/ReceivedFile";
import { keyedState } from "../../components/chat/rowState";
import type { PartFrame } from "../../components/shared/partProbe";
import {
  ARCHIVE_COMMIT,
  ARCHIVE_URL,
  COMMIT,
  EVIDENCE,
  GAP_NOTE,
  GAP_PATH,
  GITHUB_URL,
  LONG_FILE,
  UNBROKEN_TITLE,
  URL_TITLE,
} from "./skillPreviewValues";

const findings = [
  { severity: "critical", title: URL_TITLE, file: LONG_FILE, line: 1234, evidence: EVIDENCE, rationale: "Runs remote code." },
  { severity: "high", title: UNBROKEN_TITLE, file: "run.sh", line: 3 },
  { severity: "high", title: "Uses network", file: "run.sh", line: 7 },
  { severity: "low", title: URL_TITLE, file: LONG_FILE, line: 9 },
  { severity: "info", title: "Long evidence note", file: LONG_FILE, line: 42, evidence: EVIDENCE },
  { severity: "info", title: UNBROKEN_TITLE, file: "SKILL.md" },
];

function preview(source: string, commit: string, extra: Record<string, unknown>) {
  return {
    name: "pdf",
    description: "Work with PDF files: read, fill forms, merge and split.",
    source: { url: source, commit },
    files: [{ path: "SKILL.md", size: 1200 }],
    total_bytes: 1200,
    review: { summary: "Reads and writes PDF files.", capabilities: ["file access"] },
    ...extra,
  };
}

const CASES: Record<string, Record<string, unknown>> = {
  complete: preview(GITHUB_URL, COMMIT, {
    assessment: { complete: true, level: "critical", score: 12, rubric: "Scored by the rubric." },
    audit: [{ path: "SKILL.md", status: "reviewed" }],
    findings,
  }),
  incomplete: preview(ARCHIVE_URL, ARCHIVE_COMMIT, {
    assessment: { complete: false, level: "medium", score: 55, incomplete_reasons: ["Some files were too large to read."] },
    audit: [
      { path: "SKILL.md", status: "reviewed" },
      { path: GAP_PATH, status: "not_reviewed", note: GAP_NOTE },
      { path: "big.bin", status: "not_inspected" },
    ],
    review_error: `review failed: ${ARCHIVE_URL}`,
    findings,
  }),
  short: preview("https://example.com/s", "", {
    assessment: { complete: true, level: "high", score: 80 },
    audit: [{ path: "SKILL.md", status: "reviewed" }],
    findings: [
      { severity: "high", title: "Uses network", file: "run.sh", line: 7 },
      { severity: "info", title: "Short note", file: "SKILL.md", line: 2, evidence: "curl" },
    ],
  }),
  empty: preview("https://example.com/s", "", { assessment: { complete: true, level: "none", score: 100 }, audit: [], findings: [] }),
  expired: null as unknown as Record<string, unknown>,
};

function item(name: string): HistoryItem {
  const raw = CASES[name];
  const source = raw ? (raw.source as { url: string; commit: string }) : { url: "", commit: "" };
  return {
    id: `r-${name}`,
    role: "agent",
    status: "pending",
    text: "",
    timeText: "10:00",
    approval: {
      approvalRequestID: `ap-${name}`,
      status: "pending",
      toolName: "skill_install",
      toolParams: { name: "pdf", source: source.url, commit: source.commit },
      skillPreview: raw,
    },
  } as HistoryItem;
}

const current = signal("complete");
const frames = signal<Record<string, PartFrame>>({});
const width = signal(0);
const folds = keyedState<boolean>();
// Every fold starts open: findings (a fold each), the folded low ones, the notes and the rubric.
for (const name of Object.keys(CASES)) {
  const key = `r-${name}:skill`;
  for (let index = 0; index < findings.length; index++) folds.set(`${key}:finding:${index}`, true);
  for (const fold of ["folded", "notes", "rubric"]) folds.set(`${key}:${fold}`, true);
}

probeSkillInstallPreview((name, frame) => frames.update((all) => ({ ...all, [name]: frame })));

const ctx: ChatRowContext = {
  endpointRef: () => "ep_console_local",
  topicID: () => "topic",
  copiedItemID: () => "",
  copySeq: () => 0,
  detail: () => null,
  focusReturn: () => "",
  autoPreviewItemID: () => "",
  previews: createArtifactPreviews(),
  receivedFiles: createReceivedFiles(),
  questions: keyedState(),
  elevations: keyedState(),
  folds,
  onCopy: () => {},
  canEdit: () => false,
  editingItemID: () => "",
  replacedByEdit: () => false,
  onEdit: () => {},
  onPreviewFile: () => {},
  onOpenDetail: () => {},
  onTimeClick: () => {},
  onApprove: () => {},
  onDeny: () => {},
  onQuestionAnswer: () => {},
  onElevationAnswer: () => {},
};

function show(name: string) {
  if (name === current()) return;
  frames.set({});
  current.set(name);
}

function App() {
  return (
    <View class="flex-1 bg-background" onLayout={(event) => width.set(event.bounds.size.width)}>
      <View class="h-8 flex-row gap-1">
        {Object.keys(CASES).map((name) => (
          <View testID={`case-${name}`} onPress={() => show(name)} class="h-8 w-12 bg-muted">
            <Text class="text-[8px]">{name}</Text>
          </View>
        ))}
      </View>
      <View class="h-4 overflow-hidden">
        <Text class="text-xs">{`frames:${JSON.stringify({ width: width(), case: current(), frames: frames() })}`}</Text>
      </View>
      <View class="flex-1">
        <Each of={[current()]} key={(name) => name}>
          {(name) => <ChatHistoryItem item={item(name())} ctx={ctx} />}
        </Each>
      </View>
    </View>
  );
}

mount(() => <App />);
