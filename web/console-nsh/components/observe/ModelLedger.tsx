// The model ledger of the Stats page: a costs table and a tokens table, a row per model, with the
// model's vendor mark. Each table scrolls sideways on narrow windows.
import { Image, Scroll, Text, View } from "nsh";
import { modelVendorMeta } from "../../lib/core/model-vendor.js";
import { Icon } from "../ui";
import { hint, t, wholeNumber } from "./parts";
import {
  ledgerTitle,
  ledgerTone,
  ledgerUnavailable,
  ledgerValue,
  modelLedgerGroups,
  type LedgerGroup,
  type Totals,
} from "./usage-metrics";

const STUB_WIDTH = 220;
const CELL_WIDTH = 112;

export function ModelLedger(props: { models: Totals[]; scope: string }) {
  return (
    <View class="gap-4">
      <Each of={modelLedgerGroups()} key={(group) => group.key}>
        {(group) => <LedgerTable group={group()} models={props.models} scope={props.scope} />}
      </Each>
    </View>
  );
}

function LedgerTable(props: { group: LedgerGroup; models: Totals[]; scope: string }) {
  const width = () => STUB_WIDTH + (props.group.showRequests ? CELL_WIDTH : 0) + props.group.columns.length * CELL_WIDTH;
  return (
    <Scroll horizontal class="self-stretch" testID={`stats-ledger-${props.scope}-${props.group.key}`}>
      <View style={{ minWidth: width() }} class="flex-1">
        <View class="flex-row items-center gap-1.5 border-b border-line-faint pb-1.5">
          <Icon name={props.group.icon} size={14} color="subtle" />
          <Text class="font-mono text-xs uppercase tracking-wide text-subtle">{props.group.label}</Text>
        </View>
        <View class="flex-row items-center border-b border-line-faint py-1.5">
          <Text class="text-xs text-muted-foreground" style={{ width: STUB_WIDTH }}>
            {t("stats_model")}
          </Text>
          <If when={props.group.showRequests}>
            <Text class="text-right text-xs text-muted-foreground" style={{ width: CELL_WIDTH }}>
              {t("stats_requests")}
            </Text>
          </If>
          <Each of={props.group.columns} key={(column) => column.key}>
            {(column) => (
              <Text class="text-right text-xs text-muted-foreground" style={{ width: CELL_WIDTH }}>
                {column().label}
              </Text>
            )}
          </Each>
        </View>
        <Each of={props.models} key={(model) => String(model.model)}>
          {(model) => (
            <View class="flex-row items-center border-b border-line-faint py-1.5">
              <View class="flex-row items-center gap-2 pr-2" style={{ width: STUB_WIDTH }}>
                <View class="size-5 items-center justify-center rounded-(--radius) border border-line-faint bg-paper">
                  <If when={modelVendorMeta(model().model).icon} else={<Icon name="PhCpu" size={12} color="muted-foreground" />}>
                    <Image
                      src={modelVendorMeta(model().model).icon as any}
                      accessibilityLabel={modelVendorMeta(model().model).label}
                      style={{ width: 14, height: 14 }}
                    />
                  </If>
                </View>
                <Text class="flex-1 font-mono text-xs text-foreground line-clamp-1" tooltip={hint(model().model)}>
                  {String(model().model ?? "")}
                </Text>
              </View>
              <If when={props.group.showRequests}>
                <Text class="text-right text-sm text-foreground tabular-nums" style={{ width: CELL_WIDTH }}>
                  {wholeNumber(model().requests)}
                </Text>
              </If>
              <Each of={props.group.columns} key={(column) => column.key}>
                {(column) => (
                  <Text
                    class={`text-right text-sm tabular-nums ${
                      ledgerUnavailable(model(), column())
                        ? "text-muted-foreground"
                        : ledgerTone(model(), column()) === "up"
                          ? "text-danger"
                          : ledgerTone(model(), column()) === "down"
                            ? "text-ok"
                            : "text-foreground"
                    }`}
                    style={{ width: CELL_WIDTH }}
                    tooltip={hint(ledgerTitle(model(), column()))}
                  >
                    {ledgerValue(model(), column())}
                  </Text>
                )}
              </Each>
            </View>
          )}
        </Each>
      </View>
    </Scroll>
  );
}
