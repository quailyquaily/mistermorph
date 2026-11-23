# Allow wide Markdown tables to scroll horizontally on mobile

## factory · 2026-11-24 01:15
Owner request: “mobile view mark down 渲染 table 比较宽的情况下应该可以横向滚动。”

Polish Markdown table rendering in mobile views: when a table is wider than the available content area, users must be able to scroll it horizontally to read every column.

Acceptance criteria:
- Apply this behavior consistently to shared Markdown rendering in mobile web and mobile app views.
- Confine horizontal overflow to the table's container; wide tables must not widen the page, message bubble, drawer, or surrounding layout.
- Preserve readable table structure and existing styling; do not squeeze all columns into the viewport or clip inaccessible columns.
- Allow touch horizontal scrolling while preserving normal vertical page/message scrolling and interaction with links inside tables.
- Tables that already fit should not gain unnecessary scrollbars or extra spacing. Preserve desktop behavior.
- Add regression coverage for wide and fitting tables at mobile widths, including a constrained message or panel container. Record which browser/device checks were actually performed; do not claim physical-device verification from source inspection alone.
