// A notice inside a form or a page (the Vue console's AppNotice): a bracketed label, a square mark
// and the text, in the tone of what it says. Floating notices are ui.tsx's NoticeHost.
import { Text, View } from "nsh";

export function InlineNotice(props: { type?: "error" | "warning" | "info" | "success"; text: string; class?: string; testID?: string }) {
  const tone = () => {
    switch (props.type) {
      case "error":
        return { border: "border-danger", mark: "bg-danger", text: "text-danger" };
      case "warning":
        return { border: "border-warn", mark: "bg-warn", text: "text-warn-dark" };
      case "success":
        return { border: "border-ok", mark: "bg-ok", text: "text-ok" };
      default:
        return { border: "border-blue", mark: "bg-blue", text: "text-blue-dark" };
    }
  };
  return (
    <View
      role="alert"
      testID={props.testID}
      class={`flex-row items-start gap-2 border-l-2 bg-card px-3 py-2 ${tone().border} ${props.class ?? ""}`}
    >
      <View class={`mt-1.5 size-1.5 ${tone().mark}`} accessibilityElementsHidden />
      <View class="flex-1" selectable>
        <Text class={`text-sm ${tone().text}`}>{props.text}</Text>
      </View>
    </View>
  );
}
