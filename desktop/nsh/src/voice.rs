//! Voice input's microphone in the desktop app: the `morph.voice.*` calls of
//! web/console-nsh/lib/platform.ts (`voiceRecording`; the browser's side is host.js).
//!
//! The GPUI platform recognizes no speech (nsh's `Speech` is unavailable in this window), so, as in
//! a browser, the app records and the agent's transcription route (`llm.routes.transcription`)
//! transcribes the recording (POST /voice/transcribe). The recording is the system's: PipeWire's
//! `pw-record`, PulseAudio's `parecord` or ALSA's `arecord`, 16 kHz mono WAV in a temporary file
//! that goes when the app releases it. The recordings (and the recorder's log) are kept in a
//! directory of the app's alone: made at the first recording under a random name, failing rather
//! than taking one that is already there, open to the user only (0700), and each file in it is
//! created anew (0600), never opened through whatever was there before. That is Linux only for now: elsewhere, or without any of
//! them, `support` answers [`NO_RECORDER`] and a tap on the mic says so.
//!
//! The recorder runs from a thread of its own that lives as long as the app, so on Linux it gets
//! SIGTERM when the app goes (the parent-death signal follows the thread that forked).
use std::{
    ffi::OsString,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use crate::files::Picked;

/// Why the app cannot record (`morph.voice.support`, `morph.voice.start`'s `error`): no recorder.
pub const NO_RECORDER: &str = "recorder";

/// A recorder that cannot open the microphone exits within this.
const START_GRACE: Duration = Duration::from_millis(400);
/// How long a recorder may take to write its file out after SIGINT before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(3);
/// The recordings' type, as the upload sends it.
const MIME: &str = "audio/wav";

/// A program that records the microphone to a WAV file until SIGINT.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Program {
    PwRecord,
    Parecord,
    Arecord,
}

impl Program {
    /// In order of preference: PipeWire, then PulseAudio, then ALSA.
    const ALL: [Program; 3] = [Program::PwRecord, Program::Parecord, Program::Arecord];

    fn name(self) -> &'static str {
        match self {
            Program::PwRecord => "pw-record",
            Program::Parecord => "parecord",
            Program::Arecord => "arecord",
        }
    }

    /// Its arguments for 16 kHz mono 16-bit WAV at `out`, which speech-to-text models take as is.
    fn args(self, out: &Path) -> Vec<OsString> {
        let flags: &[&str] = match self {
            Program::PwRecord => &["--rate", "16000", "--channels", "1", "--format", "s16"],
            Program::Parecord => &["--rate=16000", "--channels=1", "--format=s16le", "--file-format=wav"],
            Program::Arecord => &["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav"],
        };
        let mut args: Vec<OsString> = flags.iter().map(OsString::from).collect();
        args.push(out.as_os_str().to_owned());
        args
    }
}

/// The recorder to use: the first of [`Program::ALL`] in `path` (a `PATH` value). None off Linux.
pub fn find_program(path: Option<&std::ffi::OsStr>) -> Option<(Program, PathBuf)> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let dirs: Vec<PathBuf> = std::env::split_paths(path?).collect();
    Program::ALL
        .into_iter()
        .find_map(|program| dirs.iter().map(|dir| dir.join(program.name())).find(|file| is_executable(file)).map(|file| (program, file)))
}

fn system_program() -> Option<(Program, PathBuf)> {
    find_program(std::env::var_os("PATH").as_deref())
}

#[cfg(unix)]
fn is_executable(file: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(file: &Path) -> bool {
    file.is_file()
}

/// `morph.voice.support`: "" when the app can record, else [`NO_RECORDER`].
pub fn support() -> &'static str {
    if system_program().is_some() { "" } else { NO_RECORDER }
}

type Job = Box<dyn FnOnce(&mut Worker) + Send>;
type Locate = Arc<dyn Fn() -> Option<(Program, PathBuf)> + Send + Sync>;

/// The app's microphone: one recording at a time.
pub struct Recorder {
    parent: PathBuf,
    locate: Locate,
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
}

impl Recorder {
    /// Recordings go in a private directory the recorder makes in `parent` when it first records.
    pub fn new(parent: PathBuf) -> Recorder {
        Recorder::with_program(parent, Arc::new(system_program))
    }

    /// As [`Recorder::new`], recording with the program `locate` finds when a recording starts.
    fn with_program(parent: PathBuf, locate: Locate) -> Recorder {
        Recorder { parent, locate, jobs: Mutex::new(None) }
    }

    /// Where this run of the app makes its recordings' directory: the system's temporary directory.
    pub fn default_parent() -> PathBuf {
        std::env::temp_dir()
    }

    fn worker(&self) -> Worker {
        Worker { parent: self.parent.clone(), locate: self.locate.clone(), dir: None, next: 0, session: None }
    }

    fn run(&self, job: impl FnOnce(&mut Worker) + Send + 'static) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let sender = jobs.get_or_insert_with(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            let mut worker = self.worker();
            let _ = std::thread::Builder::new().name("voice-recorder".into()).spawn(move || {
                for job in rx {
                    job(&mut worker);
                }
            });
            tx
        });
        if let Err(mpsc::SendError(job)) = sender.send(Box::new(job)) {
            // The thread could not start: answer from here, with a worker that cleans up after
            // itself as it goes (dropped, it stops its recorder and removes its directory).
            *jobs = None;
            let mut worker = self.worker();
            job(&mut worker);
        }
    }

    /// Starts recording; `reply` gets `{ ok: true }`, or `{ ok: false, error, message }` with
    /// `error` "busy", [`NO_RECORDER`], "audio-capture" (the recorder could not open the
    /// microphone) or "failed".
    pub fn start(&self, reply: impl FnOnce(Value) + Send + 'static) {
        self.run(move |worker| reply(worker.start()));
    }

    /// Stops recording; `reply` gets the recording, or None when nothing was recorded.
    pub fn stop(&self, reply: impl FnOnce(Result<Option<Picked>, String>) + Send + 'static) {
        self.run(move |worker| reply(worker.stop()));
    }

    /// Stops recording and throws the recording away.
    pub fn cancel(&self) {
        self.run(Worker::cancel);
    }

    /// Before the app quits: stops any recording, waiting for it, and removes the recordings.
    pub fn shutdown(&self) {
        let (tx, rx) = mpsc::channel();
        self.run(move |worker| {
            worker.cancel();
            if let Some(dir) = worker.dir.take() {
                let _ = dir.close();
            }
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(STOP_GRACE);
    }

    /// The app released a file: a recording of ours is deleted. Nothing was recorded before the
    /// recorder's first job, so then there is nothing to do.
    pub fn forget(&self, path: &Path) {
        if self.jobs.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
            return;
        }
        let path = path.to_owned();
        self.run(move |worker| worker.forget(&path));
    }
}

struct Session {
    child: Child,
    path: PathBuf,
    log: PathBuf,
}

struct Worker {
    parent: PathBuf,
    locate: Locate,
    /// The recordings' directory, once made; removed with everything in it when dropped.
    dir: Option<tempfile::TempDir>,
    next: u64,
    session: Option<Session>,
}

/// Makes a directory in `parent` for this run's recordings: a random name, created by this call
/// (a name already taken, by a file, a directory or a link, is never used), open to the user only.
fn make_private_dir(parent: &Path) -> std::io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("mistermorph-voice-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(parent)
}

/// Creates the file `path`, which must not exist yet (not even as a dangling link), open to the
/// user only.
fn create_private(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

impl Worker {
    /// The recordings' directory, made the first time it is needed.
    fn dir(&mut self) -> std::io::Result<PathBuf> {
        if self.dir.is_none() {
            self.dir = Some(make_private_dir(&self.parent)?);
        }
        Ok(self.dir.as_ref().map(|dir| dir.path().to_owned()).unwrap_or_default())
    }

    fn start(&mut self) -> Value {
        if self.session.is_some() {
            return json!({ "ok": false, "error": "busy" });
        }
        let Some((program, exe)) = (self.locate)() else {
            return json!({ "ok": false, "error": NO_RECORDER });
        };
        let cannot_keep = |err: std::io::Error| json!({ "ok": false, "error": "failed", "message": format!("cannot keep the recording: {err}") });
        let dir = match self.dir() {
            Ok(dir) => dir,
            Err(err) => return cannot_keep(err),
        };
        self.next += 1;
        let path = dir.join(format!("voice-{}.wav", self.next));
        let log = dir.join(format!("voice-{}.log", self.next));
        // Both files are made here, so the recorder writes into files of ours and nothing else.
        let stderr = match create_private(&log) {
            Ok(file) => Stdio::from(file),
            Err(err) => return cannot_keep(err),
        };
        if let Err(err) = create_private(&path) {
            let _ = std::fs::remove_file(&log);
            return cannot_keep(err);
        }
        let mut command = Command::new(&exe);
        command.args(program.args(&path)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(stderr);
        die_with_app(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(&log);
                return json!({ "ok": false, "error": "failed", "message": format!("{}: {err}", program.name()) });
            }
        };
        // Without a microphone (or an audio server) the recorder gives up at once.
        let deadline = Instant::now() + START_GRACE;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                let said = read_tail(&log);
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(&log);
                let message = if said.is_empty() { format!("{} exited ({status})", program.name()) } else { format!("{}: {said}", program.name()) };
                return json!({ "ok": false, "error": "audio-capture", "message": message });
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.session = Some(Session { child, path, log });
        json!({ "ok": true })
    }

    fn stop(&mut self) -> Result<Option<Picked>, String> {
        let Some(mut session) = self.session.take() else {
            return Ok(None);
        };
        interrupt(&mut session.child);
        let said = read_tail(&session.log);
        let _ = std::fs::remove_file(&session.log);
        let samples = match finish_wav(&session.path) {
            Ok(bytes) => bytes,
            Err(err) => {
                let _ = std::fs::remove_file(&session.path);
                return Err(if said.is_empty() { format!("the recording is unreadable: {err}") } else { said });
            }
        };
        if samples == 0 {
            let _ = std::fs::remove_file(&session.path);
            return Ok(None);
        }
        let mut picked = Picked::describe(&session.path).map_err(|err| format!("the recording is gone: {err}"))?;
        picked.name = "voice.wav".to_owned();
        picked.mime = MIME.to_owned();
        Ok(Some(picked))
    }

    fn cancel(&mut self) {
        if let Some(mut session) = self.session.take() {
            let _ = session.child.kill();
            let _ = session.child.wait();
            let _ = std::fs::remove_file(&session.path);
            let _ = std::fs::remove_file(&session.log);
        }
    }

    /// Deletes `path` when it is one of the recordings in this worker's directory.
    fn forget(&mut self, path: &Path) {
        if let Some(dir) = &self.dir
            && path.parent() == Some(dir.path())
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(target_os = "linux")]
fn die_with_app(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: prctl is async-signal-safe and touches no memory of the parent.
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn die_with_app(_command: &mut Command) {}

/// Asks the recorder to finish its file (SIGINT), and kills it when it has not within [`STOP_GRACE`].
fn interrupt(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGINT);
    }
    let deadline = Instant::now() + STOP_GRACE;
    while cfg!(unix) && Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The last line the recorder wrote to its log, trimmed (at most 300 characters).
fn read_tail(log: &Path) -> String {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let line = text.lines().map(str::trim).rfind(|line| !line.is_empty()).unwrap_or("");
    line.chars().take(300).collect()
}

/// Checks the WAV file at `path` and makes its sizes match what was written (a recorder that was
/// killed leaves them as it started them). Returns the bytes of sound in it.
pub fn finish_wav(path: &Path) -> std::io::Result<u64> {
    let invalid = |what: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, what.to_owned());
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    let len = file.metadata()?.len();
    let mut head = vec![0u8; len.min(4096) as usize];
    file.read_exact(&mut head)?;
    if head.len() < 12 || &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return Err(invalid("not a WAV file"));
    }
    let mut at = 12usize;
    while at + 8 <= head.len() {
        let size = u32::from_le_bytes([head[at + 4], head[at + 5], head[at + 6], head[at + 7]]) as u64;
        if &head[at..at + 4] == b"data" {
            let start = at as u64 + 8;
            let samples = len - start;
            let riff = u32::try_from(len - 8).map_err(|_| invalid("the recording is too long"))?;
            let data = u32::try_from(samples).map_err(|_| invalid("the recording is too long"))?;
            if size != samples {
                file.seek(SeekFrom::Start(4))?;
                file.write_all(&riff.to_le_bytes())?;
                file.seek(SeekFrom::Start(at as u64 + 4))?;
                file.write_all(&data.to_le_bytes())?;
            }
            return Ok(samples);
        }
        at += 8 + size as usize + (size as usize & 1);
    }
    Err(invalid("no sound in the WAV file"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mm-voice-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wav(data_size_field: u32, samples: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_size_field).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&[1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0]);
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_size_field.to_le_bytes());
        out.extend_from_slice(samples);
        out
    }

    #[test]
    fn recorders_write_16khz_mono_wav_to_the_file() {
        let out = Path::new("/tmp/v.wav");
        for program in Program::ALL {
            let args = program.args(out);
            assert_eq!(args.last().unwrap(), "/tmp/v.wav");
            let joined = args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
            assert!(joined.contains("16000"), "{joined}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_first_recorder_found_wins() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("path");
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_program(Some(&path)), None);
        assert_eq!(find_program(None), None);
        // Not executable: not a recorder.
        std::fs::write(a.join("arecord"), b"").unwrap();
        assert_eq!(find_program(Some(&path)), None);
        std::fs::set_permissions(a.join("arecord"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_program(Some(&path)), Some((Program::Arecord, a.join("arecord"))));
        // PipeWire before ALSA, wherever it is on the path.
        std::fs::write(b.join("pw-record"), b"").unwrap();
        std::fs::set_permissions(b.join("pw-record"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_program(Some(&path)), Some((Program::PwRecord, b.join("pw-record"))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wav_file_gets_the_sizes_of_what_was_written() {
        let dir = scratch("wav");
        let file = dir.join("killed.wav");
        // A killed recorder: the sizes are what it started with.
        std::fs::write(&file, wav(0x7fff_fff0, &[1, 2, 3, 4, 5, 6])).unwrap();
        assert_eq!(finish_wav(&file).unwrap(), 6);
        let fixed = std::fs::read(&file).unwrap();
        assert_eq!(fixed, wav(6, &[1, 2, 3, 4, 5, 6]));
        // Right already: left alone.
        assert_eq!(finish_wav(&file).unwrap(), 6);
        // Nothing heard.
        std::fs::write(&file, wav(0, &[])).unwrap();
        assert_eq!(finish_wav(&file).unwrap(), 0);
        // Not a WAV file.
        std::fs::write(&file, b"hello").unwrap();
        assert!(finish_wav(&file).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A recorder for the tests, standing in for `arecord`: it writes a WAV header and four bytes
    /// of sound to its file (as a killed recorder leaves it, sizes 0) and records until SIGINT. With
    /// `deaf` it says so and gives up at once, as without a microphone.
    #[cfg(target_os = "linux")]
    fn fake_recorder(dir: &Path, deaf: bool) -> Locate {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("arecord");
        let body = if deaf {
            "echo 'arecord: no such device' >&2\nexit 1\n".to_owned()
        } else {
            concat!(
                "for a; do out=$a; done\n",
                "printf 'RIFF\\044\\000\\000\\000WAVEfmt \\020\\000\\000\\000\\001\\000\\001\\000\\200\\076\\000\\000\\000\\175\\000\\000\\002\\000\\020\\000data\\000\\000\\000\\000\\001\\002\\003\\004' > \"$out\"\n",
                "echo 'fake: recording' >&2\n",
                "trap 'exit 0' INT TERM\n",
                "while :; do sleep 0.02; done\n",
            )
            .to_owned()
        };
        std::fs::write(&exe, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        Arc::new(move || Some((Program::Arecord, exe.clone())))
    }

    fn start(recorder: &Recorder) -> Value {
        let (tx, rx) = mpsc::channel();
        recorder.start(move |answer| tx.send(answer).unwrap());
        rx.recv_timeout(Duration::from_secs(5)).unwrap()
    }

    fn stop(recorder: &Recorder) -> Result<Option<Picked>, String> {
        let (tx, rx) = mpsc::channel();
        recorder.stop(move |result| tx.send(result).unwrap());
        rx.recv_timeout(Duration::from_secs(10)).unwrap()
    }

    /// The directories in `parent` the recorder made (named as it names them).
    fn made_dirs(parent: &Path, but: &Path) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path != but && path.file_name().unwrap().to_string_lossy().starts_with("mistermorph-voice-"))
            .collect();
        dirs.sort();
        dirs
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn a_private_file_is_never_one_that_was_there() {
        let dir = scratch("create");
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, b"keep me").unwrap();
        let link = dir.join("voice-1.log");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        let dangling = dir.join("voice-1.wav");
        std::os::unix::fs::symlink(dir.join("nowhere"), &dangling).unwrap();
        let plain = dir.join("voice-2.log");
        std::fs::write(&plain, b"theirs").unwrap();
        for path in [&link, &dangling, &plain] {
            assert_eq!(create_private(path).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists, "{path:?}");
        }
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep me");
        assert!(!dir.join("nowhere").exists());
        assert_eq!(std::fs::read(&plain).unwrap(), b"theirs");
        let ours = dir.join("voice-3.log");
        create_private(&ours).unwrap().write_all(b"ok").unwrap();
        assert_eq!(mode(&ours), 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_recordings_directory_is_new_random_and_private() {
        let dir = scratch("private");
        // The default umask: a directory made without asking for 0700 would be 0755.
        unsafe {
            libc::umask(0o022);
        }
        // What the app used to make, planted beforehand: never taken.
        let planted = dir.join(format!("mistermorph-voice-{}", std::process::id()));
        std::fs::create_dir_all(&planted).unwrap();
        let (a, b) = (make_private_dir(&dir).unwrap(), make_private_dir(&dir).unwrap());
        for made in [&a, &b] {
            assert_ne!(made.path(), planted);
            assert_eq!(made.path().parent(), Some(dir.as_path()));
            assert_eq!(mode(made.path()), 0o700);
        }
        assert_ne!(a.path(), b.path());
        // Not in a parent that is not there (nor making it).
        assert!(make_private_dir(&dir.join("gone")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_recording_never_writes_through_a_planted_link() {
        use std::os::unix::fs::symlink;
        let dir = scratch("planted");
        let parent = dir.join("tmp");
        std::fs::create_dir_all(&parent).unwrap();
        unsafe {
            libc::umask(0o022);
        }
        // Someone else planted the old predictable directory, with links where the files would go.
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, b"keep me").unwrap();
        let planted = parent.join(format!("mistermorph-voice-{}", std::process::id()));
        std::fs::create_dir_all(&planted).unwrap();
        for name in ["voice-1.log", "voice-1.wav"] {
            symlink(&victim, planted.join(name)).unwrap();
        }
        let recorder = Recorder::with_program(parent.clone(), fake_recorder(&dir, false));
        assert_eq!(start(&recorder), json!({ "ok": true }));
        let made = made_dirs(&parent, &planted);
        assert_eq!(made.len(), 1, "{made:?}");
        let own = &made[0];
        assert_eq!(mode(own), 0o700);
        for name in ["voice-1.log", "voice-1.wav"] {
            assert_eq!(mode(&own.join(name)), 0o600, "{name}");
            assert!(!std::fs::symlink_metadata(own.join(name)).unwrap().file_type().is_symlink());
        }
        let picked = stop(&recorder).unwrap().expect("a recording");
        assert_eq!(picked.path, own.join("voice-1.wav"));
        assert_eq!(picked.size, 48);
        assert_eq!((picked.name.as_str(), picked.mime.as_str()), ("voice.wav", MIME));
        assert!(!own.join("voice-1.log").exists());
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep me");
        // A second recording goes in the same directory, and a release removes only ours.
        assert_eq!(start(&recorder), json!({ "ok": true }));
        assert_eq!(made_dirs(&parent, &planted), made);
        recorder.cancel();
        let theirs = dir.join("picked.wav");
        std::fs::write(&theirs, b"x").unwrap();
        recorder.forget(&theirs);
        recorder.forget(&planted.join("voice-1.wav"));
        recorder.forget(&picked.path);
        assert!(matches!(stop(&recorder), Ok(None)));
        assert!(theirs.exists());
        assert!(std::fs::symlink_metadata(planted.join("voice-1.wav")).is_ok());
        assert!(!picked.path.exists());
        assert_eq!(std::fs::read_dir(own).unwrap().count(), 0, "the cancelled recording is gone");
        // Quitting removes our directory and leaves the planted one (and what it points at) alone.
        recorder.shutdown();
        assert!(!own.exists());
        assert!(planted.exists());
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep me");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_recorder_that_gives_up_leaves_nothing_behind() {
        let dir = scratch("deaf");
        let parent = dir.join("tmp");
        std::fs::create_dir_all(&parent).unwrap();
        let recorder = Recorder::with_program(parent.clone(), fake_recorder(&dir, true));
        let answer = start(&recorder);
        assert_eq!(answer["error"], "audio-capture", "{answer}");
        assert_eq!(answer["message"], "arecord: arecord: no such device");
        let made = made_dirs(&parent, Path::new(""));
        assert_eq!(made.len(), 1);
        assert_eq!(std::fs::read_dir(&made[0]).unwrap().count(), 0);
        recorder.shutdown();
        assert!(made_dirs(&parent, Path::new("")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_a_recorder_or_a_directory_nothing_starts() {
        let dir = scratch("none");
        // No recorder: no directory made either.
        let recorder = Recorder::with_program(dir.clone(), Arc::new(|| None));
        assert_eq!(start(&recorder)["error"], NO_RECORDER);
        assert!(made_dirs(&dir, Path::new("")).is_empty());
        recorder.shutdown();
        // Nowhere to keep the recording: it says so, and starts nothing.
        let recorder = Recorder::with_program(dir.join("gone"), Arc::new(|| Some((Program::Arecord, PathBuf::from("/nonexistent/arecord")))));
        let answer = start(&recorder);
        assert_eq!(answer["error"], "failed", "{answer}");
        assert!(answer["message"].as_str().unwrap().starts_with("cannot keep the recording"), "{answer}");
        assert!(matches!(stop(&recorder), Ok(None)));
        recorder.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stopping_without_a_recording_gives_nothing() {
        let dir = scratch("idle");
        let recorder = Recorder::new(dir.clone());
        let (tx, rx) = mpsc::channel();
        recorder.stop(move |result| tx.send(result.map(|p| p.is_none())).unwrap());
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), Ok(true));
        recorder.cancel();
        recorder.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Records a second from the machine's microphone with the recorder found on PATH:
    /// `cargo test -- --ignored records_from_the_microphone`.
    #[test]
    #[ignore = "needs a recorder and an audio server"]
    fn records_from_the_microphone() {
        let dir = scratch("live");
        let recorder = Recorder::new(dir.clone());
        let (tx, rx) = mpsc::channel();
        recorder.start(move |answer| tx.send(answer).unwrap());
        let answer = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(answer, json!({ "ok": true }), "{answer}");
        let (tx, rx) = mpsc::channel();
        recorder.start(move |answer| tx.send(answer).unwrap());
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["error"], "busy");
        std::thread::sleep(Duration::from_secs(1));
        let (tx, rx) = mpsc::channel();
        recorder.stop(move |result| tx.send(result).unwrap());
        let picked = rx.recv_timeout(Duration::from_secs(10)).unwrap().unwrap().expect("a recording");
        assert_eq!((picked.name.as_str(), picked.mime.as_str()), ("voice.wav", MIME));
        // A second at 16 kHz, 16-bit mono, give or take the recorder's start.
        assert!(picked.size > 44 + 16_000, "{}", picked.size);
        recorder.forget(&picked.path);
        assert!(!picked.path.exists());
        recorder.shutdown();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
