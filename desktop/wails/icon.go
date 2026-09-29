//go:build wailsdesktop && darwin

package main

import _ "embed"

// macOS draws the app icon on its own grid, with the tile inset and shadowed.
//
//go:embed packaging/appicon.png
var desktopAppIconPNG []byte
