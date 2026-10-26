// Package seal carries the sudo password of an elevated command from a client (the web Console,
// chat) to the runtime that runs the command, encrypted end to end, so it stays secret on a
// connection without TLS (docs/feat/feat_20261026_elevation_client_approval.md §3.4).
//
// For each request the runtime makes an X25519 key pair and signs the public half with its
// long-term Ed25519 identity (Identity.Offer). The client checks the signature against the identity
// it pinned, derives a key from its own new X25519 pair (ECDH, then HKDF-SHA256) and encrypts the
// password with XChaCha20-Poly1305 (Seal). The runtime decrypts it once (Opener.Open). Every step
// is bound to the request (Binding): its ID, task, command, directory and deadline.
package seal

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
)

// Version is the protocol version in Offer.Version.
const Version = 1

// label separates this protocol's signatures and keys from any other use of the same keys.
const label = "mistermorph-elevation-v1"

var (
	// ErrIdentityChanged means the runtime's identity is not the one the client pinned.
	ErrIdentityChanged = errors.New("the runtime's identity key changed")
	// ErrBadOffer means the offer is malformed or its signature does not hold.
	ErrBadOffer = errors.New("the approval request is not signed by the runtime")
	// ErrOpen means the answer could not be decrypted for this request.
	ErrOpen = errors.New("the approval answer could not be read")
	// ErrUsed means the request was already answered or given up.
	ErrUsed = errors.New("the approval request is closed")
)

// Binding is what a request's signature, key and ciphertext are bound to.
type Binding struct {
	ElevationID string
	TaskID      string
	Command     string
	Dir         string
	// Deadline counts in whole seconds.
	Deadline time.Time
}

// context is label ‖ purpose ‖ elevation ID ‖ task ID (each with its 4-byte length) ‖ SHA-256 of
// the command ‖ SHA-256 of the directory ‖ the deadline (Unix seconds, 8 bytes) ‖ x.
func (b Binding) context(purpose string, x []byte) []byte {
	var buf bytes.Buffer
	buf.WriteString(label)
	for _, field := range []string{purpose, b.ElevationID, b.TaskID} {
		_ = binary.Write(&buf, binary.BigEndian, uint32(len(field)))
		buf.WriteString(field)
	}
	command := sha256.Sum256([]byte(b.Command))
	dir := sha256.Sum256([]byte(b.Dir))
	buf.Write(command[:])
	buf.Write(dir[:])
	_ = binary.Write(&buf, binary.BigEndian, uint64(b.Deadline.Unix()))
	buf.Write(x)
	return buf.Bytes()
}

// Offer is the runtime's half of a request, sent to the client. Keys and signature are base64url
// without padding.
type Offer struct {
	Version   int    `json:"v"`
	ServerPub string `json:"server_pub"`
	Identity  string `json:"identity"`
	Signature string `json:"signature"`
}

// Answer is the client's encrypted password, base64url without padding.
type Answer struct {
	ClientPub  string `json:"client_pub"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

var b64 = base64.RawURLEncoding

// Identity is a runtime's long-term signing key.
type Identity struct {
	key ed25519.PrivateKey
}

// NewIdentity makes an identity from a 32-byte seed.
func NewIdentity(seed []byte) (*Identity, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("identity seed must be %d bytes", ed25519.SeedSize)
	}
	return &Identity{key: ed25519.NewKeyFromSeed(seed)}, nil
}

// PublicKey is the identity's public key, which clients pin.
func (id *Identity) PublicKey() ed25519.PublicKey {
	return id.key.Public().(ed25519.PublicKey)
}

// Fingerprint is how a person compares identities: the first 16 bytes of the public key's SHA-256,
// as 8 groups of 4 hex digits.
func Fingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	digits := hex.EncodeToString(sum[:16])
	groups := make([]string, 0, 8)
	for i := 0; i < len(digits); i += 4 {
		groups = append(groups, digits[i:i+4])
	}
	return strings.Join(groups, " ")
}

// EncodePublicKey and DecodePublicKey move an identity's public key as base64url.
func EncodePublicKey(pub ed25519.PublicKey) string {
	return b64.EncodeToString(pub)
}

func DecodePublicKey(s string) (ed25519.PublicKey, error) {
	raw, err := b64.DecodeString(strings.TrimSpace(s))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: bad identity key", ErrBadOffer)
	}
	return ed25519.PublicKey(raw), nil
}

// Opener is the runtime's side of one open request. It opens one answer, then forgets its key.
type Opener struct {
	binding   Binding
	serverPub []byte
	mu        sync.Mutex
	key       *ecdh.PrivateKey
}

// Offer starts a request bound to b: a new X25519 key pair, its public half signed.
func (id *Identity) Offer(b Binding) (*Opener, Offer, error) {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, Offer{}, err
	}
	opener, offer := id.offerWith(b, key)
	return opener, offer, nil
}

func (id *Identity) offerWith(b Binding, key *ecdh.PrivateKey) (*Opener, Offer) {
	serverPub := key.PublicKey().Bytes()
	signature := ed25519.Sign(id.key, b.context("offer", serverPub))
	return &Opener{binding: b, serverPub: serverPub, key: key}, Offer{
		Version:   Version,
		ServerPub: b64.EncodeToString(serverPub),
		Identity:  b64.EncodeToString(id.PublicKey()),
		Signature: b64.EncodeToString(signature),
	}
}

// Open decrypts the password in a. It works once: any answer, readable or not, closes the request.
func (o *Opener) Open(a Answer) ([]byte, error) {
	o.mu.Lock()
	key := o.key
	o.key = nil
	o.mu.Unlock()
	if key == nil {
		return nil, ErrUsed
	}
	clientPub, err1 := b64.DecodeString(a.ClientPub)
	nonce, err2 := b64.DecodeString(a.Nonce)
	ciphertext, err3 := b64.DecodeString(a.Ciphertext)
	if err1 != nil || err2 != nil || err3 != nil || len(nonce) != chacha20poly1305.NonceSizeX {
		return nil, ErrOpen
	}
	peer, err := ecdh.X25519().NewPublicKey(clientPub)
	if err != nil {
		return nil, ErrOpen
	}
	shared, err := key.ECDH(peer)
	if err != nil {
		return nil, ErrOpen
	}
	aead, err := answerCipher(o.binding, shared, o.serverPub, clientPub)
	clear(shared)
	if err != nil {
		return nil, ErrOpen
	}
	plain, err := aead.Open(nil, nonce, ciphertext, o.binding.context("answer", clientPub))
	if err != nil {
		return nil, ErrOpen
	}
	return plain, nil
}

// Close gives the request up without an answer.
func (o *Opener) Close() {
	o.mu.Lock()
	o.key = nil
	o.mu.Unlock()
}

// Seal is the client's side: it checks that offer is signed by pinned (or, when pinned is nil, by
// the identity the offer names, which the caller then pins) for request b, and encrypts password.
func Seal(b Binding, offer Offer, pinned ed25519.PublicKey, password []byte) (Answer, error) {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return Answer{}, err
	}
	nonce := make([]byte, chacha20poly1305.NonceSizeX)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return Answer{}, err
	}
	return sealWith(b, offer, pinned, password, key, nonce)
}

func sealWith(b Binding, offer Offer, pinned ed25519.PublicKey, password []byte, key *ecdh.PrivateKey, nonce []byte) (Answer, error) {
	serverPub, err := VerifyOffer(b, offer, pinned)
	if err != nil {
		return Answer{}, err
	}
	peer, err := ecdh.X25519().NewPublicKey(serverPub)
	if err != nil {
		return Answer{}, fmt.Errorf("%w: bad key", ErrBadOffer)
	}
	shared, err := key.ECDH(peer)
	if err != nil {
		return Answer{}, fmt.Errorf("%w: bad key", ErrBadOffer)
	}
	clientPub := key.PublicKey().Bytes()
	aead, err := answerCipher(b, shared, serverPub, clientPub)
	clear(shared)
	if err != nil {
		return Answer{}, err
	}
	ciphertext := aead.Seal(nil, nonce, password, b.context("answer", clientPub))
	return Answer{
		ClientPub:  b64.EncodeToString(clientPub),
		Nonce:      b64.EncodeToString(nonce),
		Ciphertext: b64.EncodeToString(ciphertext),
	}, nil
}

// VerifyOffer checks offer for request b against pinned (or the identity it names, when pinned is
// nil) and returns the runtime's X25519 public key.
func VerifyOffer(b Binding, offer Offer, pinned ed25519.PublicKey) ([]byte, error) {
	if offer.Version != Version {
		return nil, fmt.Errorf("%w: version %d", ErrBadOffer, offer.Version)
	}
	identity, err := DecodePublicKey(offer.Identity)
	if err != nil {
		return nil, err
	}
	if pinned != nil && !bytes.Equal(pinned, identity) {
		return nil, ErrIdentityChanged
	}
	serverPub, err1 := b64.DecodeString(offer.ServerPub)
	signature, err2 := b64.DecodeString(offer.Signature)
	if err1 != nil || err2 != nil || len(serverPub) != 32 {
		return nil, ErrBadOffer
	}
	if !ed25519.Verify(identity, b.context("offer", serverPub), signature) {
		return nil, ErrBadOffer
	}
	return serverPub, nil
}

// answerCipher is the XChaCha20-Poly1305 keyed by HKDF-SHA256 of the shared secret, salted with
// both public keys and bound to the request.
func answerCipher(b Binding, shared, serverPub, clientPub []byte) (cipherAEAD, error) {
	salt := append(append([]byte(nil), serverPub...), clientPub...)
	key, err := hkdf.Key(sha256.New, shared, salt, string(b.context("key", nil)), chacha20poly1305.KeySize)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	return chacha20poly1305.NewX(key)
}

type cipherAEAD interface {
	Seal(dst, nonce, plaintext, additionalData []byte) []byte
	Open(dst, nonce, ciphertext, additionalData []byte) ([]byte, error)
}
