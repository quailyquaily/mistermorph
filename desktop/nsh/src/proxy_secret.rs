//! Where the network proxy's password is kept: the system's credential store (the macOS Keychain,
//! the Windows Credential Manager, the Secret Service on Linux). There is no plaintext fallback:
//! without a store a password cannot be saved, and a saved one that cannot be read blocks the
//! start (src/proxy.rs).
use std::sync::Mutex;

/// One password, the proxy's. Errors are messages for the user and the log; they never hold the
/// password.
pub trait SecretStore: Send + Sync {
    /// Whether the store can be reached at all.
    fn available(&self) -> bool;
    /// The stored password, none when nothing is stored.
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, password: &str) -> Result<(), String>;
    /// Removes the stored password; removing nothing is not an error.
    fn delete(&self) -> Result<(), String>;
}

/// The system's credential store.
pub struct SystemStore;

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
mod system {
    use std::sync::Arc;

    use keyring_core::{CredentialStore, Entry, Error};

    const SERVICE: &str = "com.mistermorph.desktop";
    const ACCOUNT: &str = "network-proxy";

    fn store() -> Result<Arc<CredentialStore>, Error> {
        #[cfg(target_os = "macos")]
        let store: Arc<CredentialStore> = apple_native_keyring_store::keychain::Store::new()?;
        #[cfg(windows)]
        let store: Arc<CredentialStore> = windows_native_keyring_store::Store::new()?;
        #[cfg(target_os = "linux")]
        let store: Arc<CredentialStore> = zbus_secret_service_keyring_store::Store::new()?;
        Ok(store)
    }

    fn entry() -> Result<Entry, Error> {
        Entry::new_in_store(&store()?, SERVICE, ACCOUNT)
    }

    /// The store's own words, without anything it was given: the errors that carry data
    /// (`BadEncoding`, `BadDataFormat`) are named, not printed.
    fn message(err: Error) -> String {
        match err {
            Error::BadEncoding(_) => "the stored password is not text".to_owned(),
            Error::BadDataFormat(..) => "the stored password cannot be read".to_owned(),
            Error::Ambiguous(_) => "more than one stored password matches".to_owned(),
            other => other.to_string(),
        }
    }

    pub fn available() -> bool {
        // Reading an entry that may not exist reaches the store without changing it.
        match entry().and_then(|entry| entry.get_password()) {
            Ok(_) | Err(Error::NoEntry) => true,
            Err(Error::BadEncoding(_)) | Err(Error::BadDataFormat(..)) | Err(Error::Ambiguous(_)) => true,
            Err(_) => false,
        }
    }

    pub fn get() -> Result<Option<String>, String> {
        match entry().and_then(|entry| entry.get_password()) {
            Ok(password) => Ok(Some(password)),
            Err(Error::NoEntry) => Ok(None),
            Err(err) => Err(message(err)),
        }
    }

    pub fn set(password: &str) -> Result<(), String> {
        entry().and_then(|entry| entry.set_password(password)).map_err(message)
    }

    pub fn delete() -> Result<(), String> {
        match entry().and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(err) => Err(message(err)),
        }
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod system {
    const NONE: &str = "this system has no credential store the app can use";

    pub fn available() -> bool {
        false
    }
    pub fn get() -> Result<Option<String>, String> {
        Err(NONE.to_owned())
    }
    pub fn set(_password: &str) -> Result<(), String> {
        Err(NONE.to_owned())
    }
    pub fn delete() -> Result<(), String> {
        Err(NONE.to_owned())
    }
}

impl SecretStore for SystemStore {
    fn available(&self) -> bool {
        system::available()
    }
    fn get(&self) -> Result<Option<String>, String> {
        system::get()
    }
    fn set(&self, password: &str) -> Result<(), String> {
        system::set(password)
    }
    fn delete(&self) -> Result<(), String> {
        system::delete()
    }
}

/// A store in memory (tests): it can be made unavailable, as a machine without a Secret Service is.
#[derive(Default)]
pub struct MemoryStore {
    state: Mutex<MemoryState>,
}

#[derive(Default)]
struct MemoryState {
    password: Option<String>,
    unavailable: bool,
}

#[allow(dead_code)]
impl MemoryStore {
    pub fn with(password: Option<&str>) -> MemoryStore {
        let store = MemoryStore::default();
        store.state.lock().unwrap().password = password.map(str::to_owned);
        store
    }

    pub fn unavailable() -> MemoryStore {
        let store = MemoryStore::default();
        store.state.lock().unwrap().unavailable = true;
        store
    }

    pub fn set_unavailable(&self, unavailable: bool) {
        self.state.lock().unwrap().unavailable = unavailable;
    }

    /// What is stored, whatever the availability.
    pub fn stored(&self) -> Option<String> {
        self.state.lock().unwrap().password.clone()
    }

    pub fn put(&self, password: Option<&str>) {
        self.state.lock().unwrap().password = password.map(str::to_owned);
    }

    fn open(&self) -> Result<std::sync::MutexGuard<'_, MemoryState>, String> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.unavailable { Err("no credential store is available".to_owned()) } else { Ok(state) }
    }
}

impl SecretStore for MemoryStore {
    fn available(&self) -> bool {
        self.open().is_ok()
    }
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.open()?.password.clone())
    }
    fn set(&self, password: &str) -> Result<(), String> {
        self.open()?.password = Some(password.to_owned());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        self.open()?.password = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_keeps_one_password() {
        let store = MemoryStore::default();
        assert!(store.available());
        assert_eq!(store.get(), Ok(None));
        store.set("one").unwrap();
        store.set("two").unwrap();
        assert_eq!(store.get(), Ok(Some("two".to_owned())));
        store.delete().unwrap();
        store.delete().unwrap();
        assert_eq!(store.get(), Ok(None));
    }

    #[test]
    fn an_unavailable_store_refuses_everything() {
        let store = MemoryStore::with(Some("kept"));
        store.set_unavailable(true);
        assert!(!store.available());
        assert!(store.get().is_err());
        assert!(store.set("new").is_err());
        assert!(store.delete().is_err());
        assert_eq!(store.stored().as_deref(), Some("kept"));
        assert!(!MemoryStore::unavailable().available());
    }

    /// Asks the system's real credential store whether it is there, without writing to it:
    /// `cargo test -- --ignored system_store_answers --nocapture`.
    #[test]
    #[ignore]
    fn system_store_answers() {
        let store = SystemStore;
        println!("available: {}", store.available());
        println!("get: {:?}", store.get().map(|password| password.map(|_| "<a password>")));
    }
}
