package blueskyapi

import "strings"

// PeerID writes a DID without colons ("did:plc:abc" -> "did.plc.abc"), as Morph's conversation keys
// and contact IDs need. DIDFromPeer reverses it.
func PeerID(did string) string {
	did = strings.TrimSpace(did)
	if !strings.HasPrefix(did, "did:") {
		return did
	}
	return strings.Replace(did, ":", ".", 2)
}

// DIDFromPeer reads back a PeerID; a DID passed as is stays as it is.
func DIDFromPeer(peer string) string {
	peer = strings.TrimSpace(peer)
	if strings.HasPrefix(peer, "did:") || !strings.HasPrefix(peer, "did.") {
		return peer
	}
	return strings.Replace(peer, ".", ":", 2)
}

// IsDID reports a DID, in either form.
func IsDID(value string) bool {
	value = strings.TrimSpace(value)
	return strings.HasPrefix(value, "did:") || strings.HasPrefix(value, "did.")
}
