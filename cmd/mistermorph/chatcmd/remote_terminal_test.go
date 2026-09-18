package chatcmd

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// Re-execute the compiled test binary: the real program owns stdin/stdout and
// Bubble Tea's terminal driver, rather than injecting model messages.
func TestRemoteTerminalHelper(t *testing.T) {
	if os.Getenv("MISTERMORPH_PTY_HELPER") != "1" {
		return
	}
	t.Setenv("HOME", t.TempDir())
	u, err := url.Parse(os.Getenv("MISTERMORPH_PTY_URL"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := New(Dependencies{})
	cmd.SetArgs([]string{"--runtime-url", u.String()})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRemoteTerminalSmoke(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("PTY harness requires Linux and Python 3")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("PTY harness requires Python 3")
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(t.TempDir(), "remote_pty.py")
	if err := os.WriteFile(script, []byte(remoteTerminalHarness), 0600); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"explicit"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, python, script, binary)
			cmd.Env = append(os.Environ(), "MISTERMORPH_PTY_MODE="+mode)
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("PTY smoke: %v\n%s", err, output)
			}
		})
	}
}

// Standard-library-only Linux PTY driver. This exercises committed Unicode
// paste bytes, not a human IME. Output assertions inspect emitted terminal text,
// not a browser or a full terminal screen emulator.
const remoteTerminalHarness = `
import errno, fcntl, http.server, json, os, pty, re, select, signal, struct
import subprocess, sys, termios, threading, time, traceback

requests = []
submissions = []
stream_hits = 0
complete = False
class Runtime(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self): self.handle_request()
    def do_POST(self): self.handle_request()
    def do_DELETE(self): self.handle_request()
    def handle_request(self):
        global stream_hits
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        requests.append((self.command, path))
        assert self.headers.get('Authorization') == 'Bearer pty-fixture'
        status, body = 200, {}
        if path == '/runtime/health': body = {'mode': 'console'}
        elif path == '/runtime/settings/agent':
            body = {'llm': {'model': 'terminal-model'}, 'skills': {
                'loaded': [{'id': 'imagegen', 'name': 'Image Generator', 'description': 'Generate images'}],
                'available': [{'id': 'docs', 'description': 'Read documentation'}]}}
        elif path == '/runtime/workspace': body = {'workspace_dir': '/server/pty-workspace'}
        elif path == '/runtime/workspace/browse': body = {'path': '/server/pty-workspace'}
        elif path == '/runtime/topics':
            body = {'items': [{'id':'b', 'title':'Beta terminal'}, {'id':'a', 'title':'Alpha terminal'}]}
        elif path.startswith('/runtime/topics/'):
            id = path.rsplit('/', 1)[1]
            if id not in ('a', 'b'): status = 500
            else: body = {'id':id, 'title':('Alpha' if id == 'a' else 'Beta') + ' terminal'}
        elif path == '/runtime/tasks' and self.command == 'POST':
            data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            submissions.append(data)
            body = {'id':'active', 'topic_id':data.get('topic_id') or 'a', 'status':'running'}
        elif path == '/runtime/tasks':
            body = {'items':[task()] if q.get('topic_id') == ['a'] and submissions else []}
        elif path == '/runtime/tasks/active': body = task()
        elif path == '/runtime/stream/ws':
            stream_hits += 1
            status = 503  # Failed upgrade must leave HTTP polling operational.
        else: status = 404
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

def task():
    return {'id':'active', 'topic_id':'a', 'task':submissions[-1]['task'],
            'status':'done' if complete else 'running',
            'result':{'final':{'output':'HTTP-FALLBACK-FINAL'}} if complete else None}

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Runtime)
threading.Thread(target=server.serve_forever, daemon=True).start()
master, slave = pty.openpty()
def winsize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
winsize(120, 30)
env = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor',
           MISTERMORPH_PTY_HELPER='1', MISTERMORPH_RUNTIME_TOKEN='pty-fixture',
           MISTERMORPH_PTY_URL='http://127.0.0.1:%d/runtime' % server.server_port)
# Avoid inheriting terminal-specific detection from the developer's shell.
for key in ('TMUX', 'STY', 'TERM_PROGRAM', 'CI', 'NO_COLOR'):
    env.pop(key, None)
def controlling_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
proc = subprocess.Popen([sys.argv[1], '-test.run=^TestRemoteTerminalHelper$', '-test.count=1'],
                        stdin=slave, stdout=slave, stderr=slave, env=env,
                        preexec_fn=controlling_terminal)
os.close(slave)
raw = bytearray()
query_buffer = b''
queries = 0
# Answer startup capability/color/cursor queries even if split across reads.
query = re.compile(rb'\x1b\[(?:\?([0-9]+)\$p|6n|\?6n|[>]?c)|\x1b\](10|11);\?(?:\x07|\x1b\\)')
ansi = re.compile(rb'\x1b\][^\x07]*(?:\x07)|\x1b\[[0-?]*[ -/]*[@-~]')
def text(start=0):
    return ansi.sub(b'', bytes(raw[start:])).decode('utf-8', 'replace')
def pump(timeout=0.05):
    global query_buffer, queries
    if not select.select([master], [], [], timeout)[0]: return
    try: data = os.read(master, 65536)
    except OSError as e:
        if e.errno == errno.EIO: return
        raise
    raw.extend(data)
    query_buffer += data
    end = 0
    for m in query.finditer(query_buffer):
        token = m.group(0)
        if m.group(1): answer = b'\x1b[?' + m.group(1) + b';2$y'
        elif m.group(2): answer = b'\x1b]' + m.group(2) + b';rgb:0000/0000/0000\x1b\\'
        elif token.endswith(b'6n'): answer = b'\x1b[1;1R'
        else: answer = b'\x1b[?1;2c'
        os.write(master, answer)
        queries += 1
        end = m.end()
    query_buffer = query_buffer[end:][-128:]
def wait(predicate, label, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pump()
        if predicate(): return
        if proc.poll() is not None: raise AssertionError('child exited: ' + label)
    raise AssertionError('timeout: ' + label)
def expect(s, start=0, timeout=12):
    wait(lambda: s in text(start), repr(s), timeout)
def send(s): os.write(master, s.encode())
def paste(s): send('\x1b[200~' + s + '\x1b[201~')
def command(s):
    paste(s)
    send('\r')
def settle():
    # Render at least several frames; do not use stale output for next checks.
    until = time.monotonic() + .25
    while time.monotonic() < until: pump()
def resize(cols, rows):
    start = len(raw)
    winsize(cols, rows)
    os.kill(proc.pid, signal.SIGWINCH)
    wait(lambda: len(raw) > start, 'resize repaint')
    settle()
    return start

try:
    expect('Ask a question or describe a task')
    settle()
    assert 'Topics —' not in text() and 'Beta terminal' not in text(), 'startup opened the topic list'
    assert not submissions, 'startup created a topic before the first message'
    assert not any(path == '/runtime/workspace' for _, path in requests), requests
    assert queries > 0, 'terminal queries were not exercised'
    # Both runtime connections use the original command and skill picker.
    send('/')
    expect('Tab complete')
    send('\x1b')
    settle()
    send('\x03')
    paste('/top')
    settle()
    send('\x1b[B\t\r')
    expect('Topics —')
    settle()
    send('\x1b')
    settle()
    send('$')
    expect('$imagegen')
    expect('Read documentation')
    send('\x1b[B\t')
    settle()
    assert not submissions, 'picker selection submitted a task'
    send('\x03')
    settle()
    composition = '日本語かな e\u0301 👩🏽‍💻'
    paste(composition)
    settle()
    # The same unsent draft survives narrow and wide terminal resizing.
    resize(32, 10)
    start = resize(120, 30)
    expect('日本語かな', start)
    send('\r')
    wait(lambda: len(submissions) == 1, 'Unicode draft submission')
    assert submissions[0]['task'] == composition, submissions
    assert not submissions[0].get('topic_id'), submissions
    assert not submissions[0].get('workspace_dir'), submissions
    expect('stream offline; HTTP polling')
    # Retry is driven by real production polling/backoff, not injected ticks.
    wait(lambda: stream_hits >= 2, 'stream reconnect attempt', 15)
    complete = True
    expect('HTTP-FALLBACK-FINAL', timeout=12)
    command('/topics')
    expect('Beta terminal')
    expect('New topic')
    settle()
    # Refresh action key stays a list action, not a filter character.
    before = requests.count(('GET', '/runtime/topics'))
    send('\x12')
    wait(lambda: requests.count(('GET', '/runtime/topics')) > before, 'Ctrl+R refresh')
    settle()
    # Filter paste belongs to the list. Escape returns to an empty chat draft.
    paste('Beta')
    settle()
    start = len(raw)
    send('\x1b')
    expect('Ctrl+J newline', start)
    paste('after-list')
    send('\r')
    wait(lambda: len(submissions) == 2, 'draft after list Escape')
    assert submissions[1]['task'] == 'after-list', submissions
    assert submissions[1].get('topic_id') == 'a', submissions
    settle()
    command('/topics')
    settle()
    start = len(raw)
    send('\r')  # Beta sorts first; only Enter switches, not arrow navigation.
    expect('── Beta terminal ──', start)
    paste('beta-draft')
    settle()
    resize(24, 8)
    start = resize(120, 30)
    expect('beta-draft', start)
    send('\r')
    wait(lambda: len(submissions) == 3, 'Beta submission')
    assert submissions[2]['task'] == 'beta-draft', submissions
    assert submissions[2]['topic_id'] == 'b', submissions
    settle()
    command('/topics')
    settle()
    # The New topic row remains available when the list is explicitly opened.
    start = len(raw)
    send('\x1b[B\x1b[B\r')
    expect('Ask a question or describe a task', start)
    command('/topics')
    settle()
    start = len(raw)
    send('\x0e')  # Ctrl+N is an action, not a filter character.
    expect('Ask a question or describe a task', start)
    command('/quit')
    wait(lambda: proc.poll() is not None, 'quit')
    assert proc.returncode == 0, proc.returncode
    assert not any(path.endswith('/stop') or method == 'DELETE' for method, path in requests), requests
    assert len(submissions) == 3, submissions
except BaseException:
    print('PTY transcript (last 16000 bytes):', repr(bytes(raw[-16000:])))
    print('HTTP requests:', requests)
    raise
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGKILL)
    proc.wait(timeout=5)
    os.close(master)
    server.shutdown()
    server.server_close()
`
