# Popup rows: actions, choices and the highlight

A popup's rows are one of two things, and they must not look alike:

- **Actions** (a menu): each row does something. Nothing in the list is "the current one", so no
  row is marked when it opens.
- **Choices** (a picker): one row may be the current value. That row is marked (a fill, a check
  mark, or both), and only that row.

Apart from the mark there is the **highlight**: the row the arrow keys or the pointer are on, the
one Enter runs. It is a transient cursor, not a state of the data.

## Rules

1. A menu of actions opens with no row highlighted. So does a picker whose value is none of its
   rows (nothing chosen yet).
2. A picker with a chosen row opens with that row highlighted and marked.
3. The first Down highlights the first row that is not disabled, the first Up the last one; then
   they go round, passing disabled rows. A list with only disabled rows never gets a highlight.
4. Enter runs the highlighted row. With none highlighted it does nothing (it never runs an action
   nobody pointed at).
5. The pointer highlights the row it is over. In a menu of actions the highlight leaves with the
   pointer; in a picker it stays, for Enter.
6. Typing in a filter highlights its first match (Enter then picks it).
7. Screen readers: actions are `menuitem`s of a `menu`; choices are `option`s of a `listbox`, the
   chosen one `selected`. A checked menu row (the language menu) is a `menuitemcheckbox` on the
   desktops.

`PickerList` (components/shared/PickerList.tsx) takes these from one prop: a list given a `value`
is a picker, a list without one is a menu of actions. `PopoverPicker` passes the role on.

Tests read no fills, so the highlighted row is named: `<part>-highlighted-<value>` round a
`PickerList` row, `setup-picker-highlighted` in the setup picker. `DropdownMenu` takes a `testID`
for its phone list (`<testID>-popup-list`, `-option-<id>`, `-highlighted-<id>`).

## What was wrong (FT137)

`PickerList` started its highlight on the first row whenever no row matched its value. On phones
and touch screens every `DropdownMenu` is drawn by `PickerList` on the floating paper, and a menu
has no value: the first action was always filled (`bg-hover`), as a chosen row would be. Reported
on Settings → Models' top-right menu ("Advanced settings" looked chosen). The same happened to
selects opened with no value yet, and the setup picker highlighted its first row when no value was
in use, with the fill it gives a chosen row the keys are not on.

## Inventory

Every popup in the Console, as inspected for FT137. "Phone" is the floating paper
(`PopupList` → `PickerList`) on phones and touch screens; "desktop" is the popup at the trigger.

### Menus of actions

| Where | Component | Phone | Desktop |
| --- | --- | --- | --- |
| Settings → Models, top-right "···" | `DropdownMenu` | **Fixed**: first action was highlighted | nsh `Menu`: correct |
| Settings → Channels, a channel pane's "···" | `DropdownMenu` | **Fixed** (same) | correct |
| Skills, a skill's "···" | `DropdownMenu` | **Fixed** (same) | correct |
| Contacts, a contact's "···" | `DropdownMenu` | **Fixed** (same) | correct |
| TODO task editor, "···" | `DropdownMenu` | **Fixed** (same) | correct |
| Chat composer, add ("+") menu | `PopoverPicker` without a value | **Fixed**: first action was highlighted; rows were `option`s | **Fixed** (same; the bubble is `PickerList` too) |
| Chat composer, attachment sources (Android) | `AttachSourceSheet` (buttons in a dialog) | correct: plain buttons, no highlight | not shown |
| Chat composer, `/` and `$` suggestions | own list in `ChatComposer` | unchanged, see below | unchanged, see below |
| Bottom navigation, More | `NavList` in a sheet | correct: marks the current page only | not shown |
| TODO calendar, "+N more" on a day | nsh `Popover` of entry buttons | correct: no highlight | correct |

nsh's own `Menu` (0.5.1) needed no change: opened by the pointer it focuses no item; opened from
the keyboard (Enter, Space, Down on the trigger) it focuses the first item, which is the keys'
explicit focus; the pointer's focus leaves with the pointer. Its rows show focus with
`focus:bg-hover`.

The composer's `/` and `$` suggestions keep their first match highlighted: they are a typeahead
completion opened by typing, where Enter completes the highlighted match (rule 6), not a menu
opened by a press.

### Pickers (a real choice)

| Where | Component | Phone | Desktop |
| --- | --- | --- | --- |
| Chat composer, LLM profile | `PopoverPicker` with a value | correct: chosen row marked | correct |
| Sidebar / bottom navigation, agents | `AgentPicker` (`PopoverPicker`), `AgentList` (`PickerList`) | correct: current agent marked | correct |
| Language (login page) | `DropdownMenu` with `checked` rows | check mark on the current language; **fixed**: the first language was also highlighted | nsh `Menu`, `menuitemcheckbox`: correct |
| `SelectField`: Logs filters, Memories filters, LLM provider and options, channel and agent settings | nsh `Menu` of checkable rows (plain) or `Select` (searchable) | chosen row marked; **fixed** when no value is set: the first row was highlighted | correct (nsh highlights the chosen row, none without one) |
| `SettingSelect` / `SettingMenu`: settings panels, auth profiles, tools, system, units | nsh `Select` | chosen row marked; **fixed** when none is selected | correct |
| `TodoSelect`: the task editor's chat, agent, repeat and model | nsh `Select` | chosen row marked; **fixed** when none is chosen | correct |
| `DateField`: task date, Memories date | nsh `DatePicker` / calendar on the paper | correct: the chosen day marked | correct |
| Setup and Settings: API base and model pickers | `SetupPickerDialog` (a dialog on both) | **Fixed**: with no value in use the first row was highlighted | **Fixed** (same) |
| Topic tags, known tags under the field | own list in `TopicTagsEditor` | correct: no highlight until Down or Up | correct |

Not popups of rows, and unaffected: dialogs (`Modal`, `MessageDialog`, `SettingDialog`), tooltips,
and the question card's numbered answers.

## Tests

- `tests/action-popups.test.tsx` (entry `tests/fixtures/action-popups-app.tsx`): menus, pickers with
  and without a value, the setup picker; phone and desktop; opening, the keys, the pointer,
  disabled rows, Enter, Escape and Back.
- `tests/settings-menus.test.tsx`: the real Settings → Models menu on a phone.
