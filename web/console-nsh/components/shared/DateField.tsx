// A date (and time) picked from a calendar: nsh/base's DatePicker, a popup at its trigger on the
// desktops. On phones and touch screens (`popupSheets`) nsh would draw its calendar on a sheet
// flush with the screen's bottom edge, sliding up; there the calendar is on the shared floating
// paper instead (components/ui.tsx `PopupSheet`, design/mobile-popups.md): the base picker stays
// shut (`open` held false) and only says when its trigger asks to open, and the paper holds the
// same parts, styled by the same props: the calendar, the time field under it (`timePrecision`),
// and a button that clears the date (`cleanable`). A day picked sets the date and closes the
// paper, as the base picker does on touch screens; the time is set as it is edited. One date
// only: a `range` picker is not drawn on the paper.
import { signal, untracked, View } from "nsh";
import type { DatePickerProps } from "nsh/base";
import { Calendar, DatePicker, TimeField } from "nsh/base";
import { Button, PopupSheet, popupSheets } from "../ui";
import { CONTROL_CORNERS, cornersClass, fittingRadius, RADIUS } from "../corners";

/**
 * A day in a date popover's calendar (`itemClass`): a 32pt control with the controls' continuous
 * 8pt corners. The bubble's hairline and 12pt padding put the cells 13pt in from its edge, past its
 * 12pt radius, so no corner nests in another.
 */
export const CALENDAR_DAY_CLASS = `h-8 min-w-8 items-center justify-center ${CONTROL_CORNERS} text-sm text-foreground hover:bg-hover focus:bg-hover selected:bg-primary selected:text-primary-foreground disabled:opacity-50`;
/** The 24pt button that clears a date, beside its trigger (`clearButtonClass`): the controls' corners fitted to its size (7pt). */
export const DATE_CLEAR_CLASS = `ml-1 size-6 items-center justify-center ${cornersClass(fittingRadius(RADIUS.control, 24))} hover:bg-hover`;

const pad = (value: number) => String(value).padStart(2, "0");

/** The date part ("2026-03-04") and the time part ("09:30", "09:30:15") of a picker's value. */
export function splitDateValue(value: unknown): { date: string; time: string } {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/.exec(text);
  return { date: match?.[1] ?? "", time: match?.[2] ?? "" };
}

/** A picker's value from a date and a time: the date alone without a time field; `today` when no date was picked yet. */
export function joinDateValue(date: string, time: string, withTime: boolean, today: string): string {
  const day = date || today;
  if (!withTime) return day;
  return `${day}T${time || "00:00"}`;
}

function todayText() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function DateField(
  props: DatePickerProps & {
    /** The paper's title on phones (default: `accessibilityLabel`). */
    label?: string;
    /** The clear button's label on the phone's paper (default: `clearButtonAccessibilityLabel`). */
    clearLabel?: string;
  },
) {
  const sheetOpen = signal(false);
  const parts = () => splitDateValue(props.value);
  const withTime = () => !!props.timePrecision;
  const change = (date: string, time: string) =>
    props.onChange?.({ value: joinDateValue(date, time, untracked(withTime), todayText()) });
  return (
    <>
      <PopupSheet
        open={popupSheets() && sheetOpen() && !props.disabled}
        onClose={() => sheetOpen.set(false)}
        label={props.label ?? props.accessibilityLabel ?? undefined}
        testID={props.testID ? `${props.testID}-popup` : undefined}
      >
        {() => (
          <View class="shrink p-3" testID={props.testID ? `${props.testID}-popup-content` : undefined}>
            <Calendar
              value={parts().date || null}
              firstDayOfWeek={props.firstDayOfWeek}
              disabledMatcher={props.disabledMatcher}
              yearRange={props.yearRange}
              previousAccessibilityLabel={props.previousAccessibilityLabel}
              nextAccessibilityLabel={props.nextAccessibilityLabel}
              headerClass={props.headerClass}
              bodyClass={props.bodyClass}
              monthClass={props.monthClass}
              rowClass={props.rowClass}
              itemClass={props.itemClass}
              testID={props.testID ? `${props.testID}-popup-calendar` : undefined}
              onChange={({ value }) => {
                if (typeof value !== "string") return;
                change(value.slice(0, 10), untracked(parts).time);
                sheetOpen.set(false);
              }}
            />
            <If when={withTime()}>
              <View class={props.timeClass ?? undefined}>
                {props.timeLabel}
                <TimeField
                  value={parts().time || props.defaultTime || "00:00"}
                  precision={props.timePrecision ?? "minute"}
                  hourCycle={props.hourCycle}
                  accessibilityLabel={props.timeAccessibilityLabel}
                  class={props.timeFieldClass ?? undefined}
                  segmentClass={props.segmentClass}
                  separatorClass={props.separatorClass}
                  testID={props.testID ? `${props.testID}-popup-time` : undefined}
                  onChange={({ value }) => change(untracked(parts).date, value)}
                />
              </View>
            </If>
            <If when={props.cleanable && parts().date}>
              <View class="mt-3 flex-row justify-end">
                <Button
                  variant="outlined"
                  size="sm"
                  label={props.clearLabel ?? props.clearButtonAccessibilityLabel ?? "Clear"}
                  testID={props.testID ? `${props.testID}-popup-clear` : undefined}
                  onPress={() => {
                    props.onChange?.({ value: null });
                    sheetOpen.set(false);
                  }}
                />
              </View>
            </If>
          </View>
        )}
      </PopupSheet>
      <DatePicker
        {...props}
        open={popupSheets() ? false : undefined}
        onOpenChange={(event) => {
          if (untracked(popupSheets)) {
            if (event.open) sheetOpen.set(true);
            return;
          }
          props.onOpenChange?.(event);
        }}
      />
    </>
  );
}
