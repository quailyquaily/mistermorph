// A message's text: Markdown, with each ```artifact block (path= and dir_name= lines) shown as an
// artifact preview card. Ported from web/console/src/components/ChatRichContent.js.
import { View } from "nsh";
import { ArtifactPreviewCard, type ArtifactFields, type ArtifactPreviews } from "./ArtifactPreviewCard";
import { ChatMarkdown } from "./ChatMarkdown";

export interface RichSegment {
  key: string;
  kind: "markdown" | "artifact";
  source?: string;
  artifact?: ArtifactFields;
}

function parseArtifactFields(raw: string): ArtifactFields | null {
  const fields: Record<string, string> = {};
  for (const line of String(raw || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  return fields.path && fields.dir_name ? fields : null;
}

/** The Markdown and artifact parts of a text, in order. */
export function splitArtifactSegments(source: string): RichSegment[] {
  const text = String(source || "");
  if (!text) return [];
  const segments: RichSegment[] = [];
  const re = /(^|\n)(`{3,}|~{3,})[ \t]*artifact[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/gu;
  let lastIndex = 0;
  let index = 0;
  for (const match of text.matchAll(re)) {
    const prefix = match[1] || "";
    const blockStart = (match.index ?? 0) + prefix.length;
    const blockEnd = (match.index ?? 0) + match[0].length;
    const before = text.slice(lastIndex, blockStart);
    if (before.trim()) {
      segments.push({ key: `markdown:${index}`, kind: "markdown", source: before });
      index += 1;
    }
    const artifact = parseArtifactFields(match[3]);
    if (artifact) {
      segments.push({ key: `artifact:${index}:${artifact.path}`, kind: "artifact", artifact });
    } else {
      segments.push({ key: `markdown:${index}`, kind: "markdown", source: text.slice(blockStart, blockEnd) });
    }
    index += 1;
    lastIndex = blockEnd;
  }
  const rest = text.slice(lastIndex);
  if (rest.trim()) segments.push({ key: `markdown:${index}`, kind: "markdown", source: rest });
  return segments;
}

/** Whether a text has an artifact block (the reply whose preview opens by itself). */
export function hasArtifactBlock(raw: string) {
  return /(^|\n)(`{3,}|~{3,})[ \t]*artifact[^\n]*\n/iu.test(String(raw || ""));
}

export function ChatRichContent(props: {
  source: string;
  /** The key of the message, for the state of its artifact cards. */
  ownerKey: string;
  endpointRef: string;
  fallbackTopicID?: string;
  autoPreview?: boolean;
  streaming?: boolean;
  previews: ArtifactPreviews;
  class?: string;
}) {
  const segments = () => splitArtifactSegments(props.source);
  return (
    <View class={`gap-3 ${props.class ?? ""}`}>
      <Each of={segments()} key={(segment) => segment.key}>
        {(segment) => (
          <If
            when={segment().kind === "artifact"}
            else={<ChatMarkdown source={segment().source ?? ""} streaming={props.streaming} />}
          >
            <ArtifactPreviewCard
              artifact={segment().artifact ?? {}}
              endpointRef={props.endpointRef}
              fallbackTopicID={props.fallbackTopicID}
              autoPreview={props.autoPreview}
              stateKey={`${props.ownerKey}|${segment().key}`}
              previews={props.previews}
            />
          </If>
        )}
      </Each>
    </View>
  );
}
