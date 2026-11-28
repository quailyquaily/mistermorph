package consolecmd

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// Uploads through the Console's proxy (POST /api/proxy?uri=/files/upload): every client (the
// browser, the desktop and phone apps) attaches files this way. The request body is streamed to
// the endpoint as it arrives, never held whole in memory: the in-process runtime parses it as it
// reads (parts over 8 MiB go to temporary files), a remote one is sent it as it comes. The proxy
// refuses a request over the runtime's budget (daemonruntime.FileUploadMaxRequestBytes) itself,
// before or while reading it; the runtime checks each file and the request again.
//
// At most consoleUploadConcurrency uploads stream at once, process-wide: another is refused at
// once with 503 and Retry-After, so many clients cannot stack up parsers and temporary files.

// consoleUploadConcurrency is how many uploads the proxy streams at once (two composers' two uploads).
const consoleUploadConcurrency = 4

// consoleUploadRetryAfter is what a refused upload is told to wait, in seconds.
const consoleUploadRetryAfter = 5

// consoleUploadSlots holds one token per upload streaming now. A variable for tests.
var consoleUploadSlots = make(chan struct{}, consoleUploadConcurrency)

// runtimeEndpointUploader streams an upload request to an endpoint (both endpoint clients do).
type runtimeEndpointUploader interface {
	ProxyUpload(ctx context.Context, endpointPath string, body io.Reader, contentLength int64, contentType string) (int, []byte, error)
}

// uploadBody reads the browser's request within the budget and remembers when it ran past it.
type uploadBody struct {
	r        io.Reader
	exceeded bool
}

func (b *uploadBody) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	var maxBytesErr *http.MaxBytesError
	if err != nil && errors.As(err, &maxBytesErr) {
		b.exceeded = true
	}
	return n, err
}

func writeUploadRequestTooLarge(w http.ResponseWriter) {
	w.Header().Set("Connection", "close")
	daemonruntime.WriteUploadRefusal(w, http.StatusRequestEntityTooLarge, daemonruntime.UploadCodeRequestTooLarge,
		daemonruntime.UploadRequestTooLargeMessage(), daemonruntime.FileUploadMaxRequestBytes)
}

func (s *server) handleProxyUpload(w http.ResponseWriter, r *http.Request, endpoint runtimeEndpoint, target *url.URL) {
	if r.ContentLength > daemonruntime.FileUploadMaxRequestBytes {
		writeUploadRequestTooLarge(w)
		return
	}
	select {
	case consoleUploadSlots <- struct{}{}:
		defer func() { <-consoleUploadSlots }()
	default:
		w.Header().Set("Retry-After", strconv.Itoa(consoleUploadRetryAfter))
		daemonruntime.WriteUploadRefusal(w, http.StatusServiceUnavailable, daemonruntime.UploadCodeBusy,
			"the console is receiving other uploads; try again in a few seconds", 0)
		return
	}

	body := &uploadBody{r: http.MaxBytesReader(w, r.Body, daemonruntime.FileUploadMaxRequestBytes)}
	proxyCtx := daemonruntime.WithClientRemote(r.Context(), daemonruntime.DirectRemote(r))
	contentType := r.Header.Get("Content-Type")
	var (
		status int
		raw    []byte
		err    error
	)
	if uploader, ok := endpoint.Client.(runtimeEndpointUploader); ok {
		status, raw, err = uploader.ProxyUpload(proxyCtx, target.RequestURI(), body, r.ContentLength, contentType)
	} else {
		// An endpoint client that cannot stream (test stand-ins): the body, within the budget.
		var buffered []byte
		buffered, err = io.ReadAll(body)
		if err == nil {
			status, raw, err = endpoint.Client.Proxy(proxyCtx, r.Method, target.RequestURI(), buffered, contentType)
		}
	}
	if body.exceeded {
		writeUploadRequestTooLarge(w)
		return
	}
	if err != nil {
		if isTimeout(err) {
			writeError(w, http.StatusGatewayTimeout, "the agent did not take the upload in time")
			return
		}
		if r.Context().Err() != nil {
			// The client went away: nobody reads an answer.
			writeError(w, http.StatusBadRequest, "upload cancelled")
			return
		}
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	w.Header().Set(proxyUpstreamResponseHeader, "1")
	writeJSONProxyResponse(w, status, raw)
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}
