// The model ledger of the Stats page: a costs table and a tokens table, a row per model, with the
// model's vendor mark. Each table scrolls sideways on narrow windows.
import { Image, Scroll, signal, Text, View, windowSize } from "nsh";
import { modelVendorMeta } from "../../lib/core/model-vendor.js";
import { SCROLLBAR } from "../motion";
import { Icon } from "../ui";
import { hint, t, wholeNumber } from "./parts";
import {
  ledgerTitle,
  ledgerTone,
  ledgerUnavailable,
  ledgerValue,
  modelLedgerGroups,
  type LedgerColumn,
  type LedgerGroup,
  type Totals,
} from "./usage-metrics";

// Vue's .stats-model-ledger-* metrics: the model column 196 wide (164 on phones), requests 88 (112 here: the tracked caps label is wider than 88 and Vue lets it grow),
// values at least 132; header cells padded 11/12/10, body cells 13/12/12; every cell on hairlines.
const CELL_WIDTH = 132;
const REQUESTS_WIDTH = 112;
const HEAD_HEIGHT = 38;
const ROW_HEIGHT = 48;
const LABEL = "font-mono text-xs font-medium uppercase leading-normal tracking-[0.12em] text-subtle";

export function ModelLedger(props: { models: Totals[]; scope: string }) {
  return (
    <View class="gap-4">
      <Each of={modelLedgerGroups()} key={(group) => group.key}>
        {(group) => <LedgerTable group={group()} models={props.models} scope={props.scope} />}
      </Each>
    </View>
  );
}

/**
 * One table: its group head across the top, then the model column, which stays in view, beside
 * the figures, which scroll sideways when the window is narrower than the table (Vue keeps the
 * model column sticky). The figures stretch to the table's width when it is wider.
 */
function LedgerTable(props: { group: LedgerGroup; models: Totals[]; scope: string }) {
  const stubWidth = () => (windowSize().width <= 560 ? 164 : 196);
  const viewport = signal(0);
  const figuresWidth = () => (props.group.showRequests ? REQUESTS_WIDTH : 0) + props.group.columns.length * CELL_WIDTH;
  const valueTone = (model: Totals, column: LedgerColumn) =>
    ledgerUnavailable(model, column)
      ? "font-medium text-subtle"
      : ledgerTone(model, column) === "up"
        ? "font-semibold text-danger"
        : ledgerTone(model, column) === "down"
          ? "font-semibold text-ok"
          : "font-semibold text-foreground";
  return (
    <View class="border-y border-line-soft" testID={`stats-ledger-${props.scope}-${props.group.key}`}>
      <View class="flex-row items-center gap-2 border-b border-line-soft bg-blue/5 px-3" style={{ height: HEAD_HEIGHT }}>
        <Icon name={props.group.icon} size={14} color="ink" />
        <Text class="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-foreground">{props.group.label}</Text>
      </View>
      <View class="flex-row">
        <View class="border-r border-line-soft" style={{ width: stubWidth() }}>
          <View class="justify-end border-b border-line-soft bg-blue/5 px-3 pb-2.5" style={{ height: HEAD_HEIGHT }}>
            <Text class={LABEL}>{t("stats_model")}</Text>
          </View>
          <Each of={props.models} key={(model) => String(model.model)}>
            {(model, index) => (
              <View
                class={`flex-row items-start gap-2.5 bg-secondary px-3 pt-3.25 ${index() < props.models.length - 1 ? "border-b border-line-soft" : ""}`}
                style={{ height: ROW_HEIGHT }}
              >
                <View class="size-5.5 items-center justify-center overflow-hidden rounded-full border border-line-soft bg-white p-0.75">
                  <If when={modelVendorMeta(model().model).icon} else={<Icon name="PhCpu" size={13} color="subtle" />}>
                    <Image
                      src={modelVendorMeta(model().model).icon as any}
                      accessibilityLabel={modelVendorMeta(model().model).label}
                      style={{ width: 14, height: 14, objectFit: "contain" }}
                    />
                  </If>
                </View>
                <Text class="flex-1 font-mono text-sm font-semibold leading-[20.3px] text-foreground line-clamp-1" tooltip={hint(model().model)}>
                  {String(model().model ?? "")}
                </Text>
              </View>
            )}
          </Each>
        </View>
        <Scroll horizontal scrollbar={SCROLLBAR} class="flex-1" onLayout={({ bounds }) => viewport.set(bounds.size.width)}>
          <View style={{ width: Math.max(figuresWidth(), viewport()) }}>
            <View class="flex-row border-b border-line-soft bg-blue/5" style={{ height: HEAD_HEIGHT }}>
              <If when={props.group.showRequests}>
                <HeadCell label={t("stats_requests")} width={REQUESTS_WIDTH} />
              </If>
              <Each of={props.group.columns} key={(column) => column.key}>
                {(column, index) => <HeadCell label={column().label} width={CELL_WIDTH} last={index() === props.group.columns.length - 1} />}
              </Each>
            </View>
            <Each of={props.models} key={(model) => String(model.model)}>
              {(model, rowIndex) => (
                <View class={`flex-row ${rowIndex() < props.models.length - 1 ? "border-b border-line-soft" : ""}`} style={{ height: ROW_HEIGHT }}>
                  <If when={props.group.showRequests}>
                    <View class="border-r border-line-soft px-3 pt-3.25" style={{ flexGrow: REQUESTS_WIDTH, flexBasis: REQUESTS_WIDTH }}>
                      <Text class={`text-right ${VALUE} font-semibold text-foreground`}>{wholeNumber(model().requests)}</Text>
                    </View>
                  </If>
                  <Each of={props.group.columns} key={(column) => column.key}>
                    {(column, index) => (
                      <View
                        class={`px-3 pt-3.25 ${index() < props.group.columns.length - 1 ? "border-r border-line-soft" : ""}`}
                        style={{ flexGrow: CELL_WIDTH, flexBasis: CELL_WIDTH }}
                        tooltip={hint(ledgerTitle(model(), column()))}
                      >
                        <Text class={`text-right ${VALUE} ${valueTone(model(), column())}`}>{ledgerValue(model(), column())}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </View>
    </View>
  );
}

const VALUE = "text-base leading-[16.8px] tabular-nums";

function HeadCell(props: { label: string; width: number; last?: boolean }) {
  return (
    <View
      class={`justify-end px-3 pb-2.5 ${props.last ? "" : "border-r border-line-soft"}`}
      style={{ flexGrow: props.width, flexBasis: props.width }}
    >
      <Text class={`text-right ${LABEL} line-clamp-1`}>{props.label}</Text>
    </View>
  );
}
