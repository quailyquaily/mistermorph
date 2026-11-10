# Align coder output styling with progress output

## factory · 2026-11-11 00:40
Owner requested this UI fix in Console; recorded in new for implementation.

Request: coder 的输出框样式应该和 progress 一样是暗色背景，别的样式也应该一样。

Acceptance:
- Give coder output the same dark background and visual treatment as progress output, including typography, spacing, borders and corner treatment.
- Prefer shared styling so the two output containers stay consistent; preserve their distinct content and behavior.
- Verify both output types in the chat view, including empty and populated states.
