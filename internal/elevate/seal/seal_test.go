package seal

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var updateVectors = flag.Bool("update", false, "rewrite testdata/vectors.json")

func testBinding() Binding {
	return Binding{
		ElevationID: "el_4f2a9c",
		TaskID:      "task_01",
		Command:     "apt-get install -y jq",
		Dir:         "/srv/app",
		Deadline:    time.Unix(1_800_000_120, 0),
	}
}

func testIdentity(t *testing.T) *Identity {
	t.Helper()
	id, err := NewIdentity(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSealOpenRoundTrip(t *testing.T) {
	id := testIdentity(t)
	b := testBinding()
	opener, offer, err := id.Offer(b)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := Seal(b, offer, id.PublicKey(), []byte("hunter2"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := opener.Open(answer)
	if err != nil || string(got) != "hunter2" {
		t.Fatalf("Open = %q, %v", got, err)
	}
	if _, err := opener.Open(answer); !errors.Is(err, ErrUsed) {
		t.Fatalf("second Open error = %v, want ErrUsed", err)
	}
}

// The client refuses an offer it cannot trust, and the runtime refuses an answer made for anything
// but this request.
func TestSealRejectsTampering(t *testing.T) {
	id := testIdentity(t)
	other, err := NewIdentity(bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	b := testBinding()

	t.Run("pinned identity changed", func(t *testing.T) {
		_, offer, _ := other.Offer(b)
		if _, err := Seal(b, offer, id.PublicKey(), []byte("x")); !errors.Is(err, ErrIdentityChanged) {
			t.Fatalf("err = %v, want ErrIdentityChanged", err)
		}
	})
	t.Run("server key swapped", func(t *testing.T) {
		_, offer, _ := id.Offer(b)
		_, swapped, _ := id.Offer(b)
		offer.ServerPub = swapped.ServerPub
		if _, err := Seal(b, offer, id.PublicKey(), []byte("x")); !errors.Is(err, ErrBadOffer) {
			t.Fatalf("err = %v, want ErrBadOffer", err)
		}
	})
	t.Run("offer for another command", func(t *testing.T) {
		_, offer, _ := id.Offer(b)
		shown := b
		shown.Command = "rm -rf /"
		if _, err := Seal(shown, offer, id.PublicKey(), []byte("x")); !errors.Is(err, ErrBadOffer) {
			t.Fatalf("err = %v, want ErrBadOffer", err)
		}
	})

	fields := map[string]func(*Binding){
		"elevation id": func(b *Binding) { b.ElevationID = "el_other" },
		"task":         func(b *Binding) { b.TaskID = "task_02" },
		"command":      func(b *Binding) { b.Command = "rm -rf /" },
		"directory":    func(b *Binding) { b.Dir = "/" },
		"deadline":     func(b *Binding) { b.Deadline = b.Deadline.Add(time.Hour) },
	}
	for name, change := range fields {
		t.Run("answer bound to another "+name, func(t *testing.T) {
			opener, offer, _ := id.Offer(b)
			// The client sees a request that differs in one field, signed for it.
			other := b
			change(&other)
			_, otherOffer, _ := id.Offer(other)
			otherOffer.ServerPub = offer.ServerPub
			answer, err := sealUnchecked(other, offer, []byte("hunter2"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := opener.Open(answer); !errors.Is(err, ErrOpen) {
				t.Fatalf("Open error = %v, want ErrOpen", err)
			}
		})
	}
	t.Run("ciphertext changed", func(t *testing.T) {
		opener, offer, _ := id.Offer(b)
		answer, _ := Seal(b, offer, id.PublicKey(), []byte("hunter2"))
		raw, _ := b64.DecodeString(answer.Ciphertext)
		raw[0] ^= 1
		answer.Ciphertext = b64.EncodeToString(raw)
		if _, err := opener.Open(answer); !errors.Is(err, ErrOpen) {
			t.Fatalf("Open error = %v, want ErrOpen", err)
		}
	})
	t.Run("closed request", func(t *testing.T) {
		opener, offer, _ := id.Offer(b)
		answer, _ := Seal(b, offer, id.PublicKey(), []byte("hunter2"))
		opener.Close()
		if _, err := opener.Open(answer); !errors.Is(err, ErrUsed) {
			t.Fatalf("Open error = %v, want ErrUsed", err)
		}
	})
}

// sealUnchecked encrypts for offer's key as a client bound to b would, skipping the signature
// check, to show the runtime still refuses it.
func sealUnchecked(b Binding, offer Offer, password []byte) (Answer, error) {
	key, _ := ecdh.X25519().GenerateKey(bytes.NewReader(bytes.Repeat([]byte{3}, 64)))
	serverPub, _ := b64.DecodeString(offer.ServerPub)
	peer, _ := ecdh.X25519().NewPublicKey(serverPub)
	shared, _ := key.ECDH(peer)
	clientPub := key.PublicKey().Bytes()
	aead, err := answerCipher(b, shared, serverPub, clientPub)
	if err != nil {
		return Answer{}, err
	}
	nonce := bytes.Repeat([]byte{1}, 24)
	return Answer{
		ClientPub:  b64.EncodeToString(clientPub),
		Nonce:      b64.EncodeToString(nonce),
		Ciphertext: b64.EncodeToString(aead.Seal(nil, nonce, password, b.context("answer", clientPub))),
	}, nil
}

// vectors pins the wire format, for the Go and JavaScript clients alike
// (web/console/src/core/elevation-seal.test.mjs reads the same file).
type vectors struct {
	IdentitySeed string `json:"identity_seed_hex"`
	ServerKey    string `json:"server_private_hex"`
	ClientKey    string `json:"client_private_hex"`
	Nonce        string `json:"nonce_hex"`
	Binding      struct {
		ElevationID string `json:"elevation_id"`
		TaskID      string `json:"task_id"`
		Command     string `json:"command"`
		Dir         string `json:"cwd"`
		Deadline    int64  `json:"deadline"`
	} `json:"binding"`
	Password    string `json:"password"`
	Fingerprint string `json:"fingerprint"`
	Offer       Offer  `json:"offer"`
	Answer      Answer `json:"answer"`
}

func TestVectors(t *testing.T) {
	seed := bytes.Repeat([]byte{7}, 32)
	serverKey, _ := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{0x11}, 32))
	clientKey, _ := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{0x22}, 32))
	nonce := bytes.Repeat([]byte{0x33}, 24)
	id, _ := NewIdentity(seed)
	b := testBinding()
	opener, offer := id.offerWith(b, serverKey)
	answer, err := sealWith(b, offer, id.PublicKey(), []byte("hunter2 ü"), clientKey, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := opener.Open(answer); err != nil || string(got) != "hunter2 ü" {
		t.Fatalf("Open = %q, %v", got, err)
	}

	var v vectors
	v.IdentitySeed = hex.EncodeToString(seed)
	v.ServerKey = hex.EncodeToString(serverKey.Bytes())
	v.ClientKey = hex.EncodeToString(clientKey.Bytes())
	v.Nonce = hex.EncodeToString(nonce)
	v.Binding.ElevationID, v.Binding.TaskID, v.Binding.Command, v.Binding.Dir, v.Binding.Deadline = b.ElevationID, b.TaskID, b.Command, b.Dir, b.Deadline.Unix()
	v.Password = "hunter2 ü"
	v.Fingerprint = Fingerprint(id.PublicKey())
	v.Offer = offer
	v.Answer = answer
	got, _ := json.MarshalIndent(v, "", "  ")
	got = append(got, '\n')
	path := filepath.Join("testdata", "vectors.json")
	if *updateVectors {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update to write it)", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("the wire format changed; clients reading %s must change with it:\n%s", path, got)
	}
}

func TestLoadIdentityKeepsOneKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "elevation_identity")
	first, err := LoadIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("identity file: %v, mode %v", err, info.Mode())
	}
	again, err := LoadIdentity(path)
	if err != nil || !bytes.Equal(first.PublicKey(), again.PublicKey()) {
		t.Fatalf("reloaded identity differs: %v", err)
	}
	if fp := Fingerprint(first.PublicKey()); len(fp) != 39 {
		t.Fatalf("fingerprint = %q", fp)
	}
}
