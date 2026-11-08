//! Voice input's microphone in the desktop app: the `morph.voice.*` calls of
//! web/console-nsh/lib/platform.ts (`voiceRecording`; the browser's side is host.js).
//!
//! The GPUI platform recognizes no speech (nsh's `Speech` is unavailable in this window), so, as in
//! a browser, the app records and the agent's transcription route (`llm.routes.transcription`)
//! transcribes the recording (POST /voice/transcribe). The recording is the system's: PipeWire's
//! `pw-record`, PulseAudio's `parecord` or ALSA's `arecord`, 16 kHz mono WAV in a temporary file
//! that goes when the app releases it. That is Linux only for now: elsewhere, or without any of
//! them, `support` answers [`NO_RECORDER`] and a tap on the mic says so.
//!
//! The recorder runs from a thread of its own that lives as long as the app, so on Linux it gets
//! SIGTERM when the app goes (the parent-death signal follows the thread that forked).
use std::{
    ffi::OsString,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, mpsc},
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

/// The app's microphone: one recording at a time.
pub struct Recorder {
    dir: PathBuf,
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
}

impl Recorder {
    /// Recordings go in `dir`, which is the recorder's own.
    pub fn new(dir: PathBuf) -> Recorder {
        Recorder { dir, jobs: Mutex::new(None) }
    }

    /// Where this run of the app keeps its recordings.
    pub fn default_dir() -> PathBuf {
        std::env::temp_dir().join(format!("mistermorph-voice-{}", std::process::id()))
    }

    fn run(&self, job: impl FnOnce(&mut Worker) + Send + 'static) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let sender = jobs.get_or_insert_with(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            let mut worker = Worker { dir: self.dir.clone(), next: 0, session: None };
            let _ = std::thread::Builder::new().name("voice-recorder".into()).spawn(move || {
                for job in rx {
                    job(&mut worker);
                }
                worker.cancel();
            });
            tx
        });
        if let Err(mpsc::SendError(job)) = sender.send(Box::new(job)) {
            // The thread could not start: answer from here, without a recorder of its own.
            *jobs = None;
            let mut worker = Worker { dir: self.dir.clone(), next: 0, session: None };
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
            let _ = std::fs::remove_dir_all(&worker.dir);
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(STOP_GRACE);
    }

    /// The app released a file: a recording of ours is deleted.
    pub fn forget(&self, path: &Path) {
        if path.starts_with(&self.dir) {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct Session {
    child: Child,
    path: PathBuf,
    log: PathBuf,
}

struct Worker {
    dir: PathBuf,
    next: u64,
    session: Option<Session>,
}

impl Worker {
    fn start(&mut self) -> Value {
        if self.session.is_some() {
            return json!({ "ok": false, "error": "busy" });
        }
        let Some((program, exe)) = system_program() else {
            return json!({ "ok": false, "error": NO_RECORDER });
        };
        if let Err(err) = std::fs::create_dir_all(&self.dir) {
            return json!({ "ok": false, "error": "failed", "message": format!("cannot keep the recording: {err}") });
        }
        self.next += 1;
        let path = self.dir.join(format!("voice-{}.wav", self.next));
        let log = self.dir.join(format!("voice-{}.log", self.next));
        let stderr = match std::fs::File::create(&log) {
            Ok(file) => Stdio::from(file),
            Err(_) => Stdio::null(),
        };
        let mut command = Command::new(&exe);
        command.args(program.args(&path)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(stderr);
        die_with_app(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
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

    #[test]
    fn only_our_own_recordings_are_deleted_on_release() {
        let dir = scratch("forget");
        let recorder = Recorder::new(dir.join("voice"));
        std::fs::create_dir_all(dir.join("voice")).unwrap();
        let ours = dir.join("voice").join("voice-1.wav");
        let theirs = dir.join("picked.wav");
        std::fs::write(&ours, b"x").unwrap();
        std::fs::write(&theirs, b"x").unwrap();
        recorder.forget(&theirs);
        recorder.forget(&ours);
        assert!(theirs.exists());
        assert!(!ours.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stopping_without_a_recording_gives_nothing() {
        let dir = scratch("idle");
        let recorder = Recorder::new(dir.join("voice"));
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
        let recorder = Recorder::new(dir.join("voice"));
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
        assert!(!dir.join("voice").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
