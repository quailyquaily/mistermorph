# Ultraviolet inline renderer fix

This directory contains the production Go sources and license from
`github.com/charmbracelet/ultraviolet`
`v0.0.0-20260811164956-006e29f97886`. The root module uses this copy through
a `replace` directive. Upstream tests and examples are omitted.

The only source change is in `TerminalRenderer.Render`: before a full repaint
shrinks an inline frame, move to the old frame's origin while the old buffer
height is still available. Otherwise `move` clamps the remembered cursor row
to the new height and moves up too few rows. Filtering or closing the chat
command menu then leaves parts of the previous input frame on screen.

Remove this copy and the replacement when an upstream release includes the
fix. Check menu expansion, filtering and dismissal, multiline input collapse,
approval dismissal, and transcript output when upgrading.
