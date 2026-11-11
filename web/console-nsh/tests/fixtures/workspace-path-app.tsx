// A test entry for tests/workspace-path-line.test.tsx: the workspace panel's path line
// (WorkspacePathLine) in a box whose width the buttons set, showing a path the buttons pick, as
// the panel writes it (the home as `~`, split before the last part). The line reports its widths,
// height and text; they and the box's width are read out below it as JSON.
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../components/ui";
import { probePathLines, WorkspacePathLine, type PathLineFrame } from "../../components/chat/WorkspacePathLine";
import { workspacePathDisplay } from "../../components/chat/workspacePath";

const HOME = "/home/me";
const PATHS: Record<string, string> = {
  home: "/home/me",
  short: "/home/me/notes",
  long: "/home/me/code/clients/acme/monorepo/services/billing-gateway/internal/reconciliation-worker",
  outside: "/srv/data/projects/archive/2026/quarterly-reports/finance-department-final",
  wide: "/home/me/文档/项目/客户资料/二零二六年度/季度报告/财务部门最终版本",
};
const WIDTHS = [80, 160, 240, 320, 480, 960];

const pathKey = signal("long");
const width = signal(240);
const box = signal(0);
const line = signal<PathLineFrame | null>(null);
probePathLines((frame) => line.set(frame));

const display = () => workspacePathDisplay(PATHS[pathKey()], HOME);

function Page() {
  return (
    <View class="flex-1 bg-background p-2">
      <View class="flex-row flex-wrap gap-1">
        <Each of={Object.keys(PATHS)} key={(k) => k}>
          {(k) => <Button testID={`path-${k()}`} size="xs" label={k()} onPress={() => pathKey.set(k())} />}
        </Each>
        <Each of={WIDTHS} key={(w) => String(w)}>
          {(w) => <Button testID={`width-${w()}`} size="xs" label={String(w())} onPress={() => width.set(w())} />}
        </Each>
      </View>
      <View class="mt-2 gap-1 border border-line" style={{ width: width() }} onLayout={(e) => box.set(e.bounds.size.width)}>
        <WorkspacePathLine
          path={display().text}
          leafStart={display().leafStart}
          textClass="font-mono text-xs leading-5"
          accessibilityLabel={PATHS[pathKey()]}
          testID="workspace-path"
        />
      </View>
      <Text class="text-[6px]">{JSON.stringify({ box: box(), path: PATHS[pathKey()], line: line() })}</Text>
    </View>
  );
}

mount(() => <Page />);
