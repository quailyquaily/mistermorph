package agentlink

import (
	"net/http"

	"github.com/gorilla/websocket"
)

// WebSocketHandler serves the node's Agent Link stream to a Console. authorize checks the request
// before the upgrade. The default origin check refuses cross-origin browser requests; a Console
// dials without an Origin header.
func (n *Node) WebSocketHandler(authorize func(*http.Request) bool) http.Handler {
	upgrader := websocket.Upgrader{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if authorize != nil && !authorize(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		if err := n.Serve(r.Context(), NewWebSocketConn(ws)); err != nil {
			n.logger.Info("agentlink_console_disconnected", "remote", r.RemoteAddr, "error", err.Error())
		}
	})
}
