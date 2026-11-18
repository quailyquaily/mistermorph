//! The GPUI main thread as nsh's backends need it: running closures sent
//! from other threads ([`invoke`]), timers ([`after_ms`]) and redrawing
//! the surfaces whose views changed ([`flush`]).
//!
//! GPUI's executors are bound to the main thread, so [`init`] spawns one
//! foreground task per process that drains a channel of closures; any
//! thread may send into it (the engine's sink, image decoders, network
//! callbacks). Every entry point on the main thread (a closure run here,
//! a timer, an input event, a frame) ends with [`flush`], which notifies
//! the views of the surfaces that asked to be drawn again: views change
//! outside GPUI's tracked state, so GPUI Fast's retained rendering needs
//! that `notify`.

use std::{cell::RefCell, sync::OnceLock, time::Duration};

use futures_channel::mpsc::{UnboundedSender, unbounded};
use gpui::{App, AsyncApp};

type Job = Box<dyn FnOnce() + Send>;

static JOBS: OnceLock<UnboundedSender<Job>> = OnceLock::new();

thread_local! {
    /// The app's async handle (main thread): timers spawn on it.
    static APP: RefCell<Option<AsyncApp>> = const { RefCell::new(None) };
}

/// Sets up the main-thread queue (once per process; later calls only
/// refresh the app handle). Called when the first surface is made.
pub(crate) fn init(cx: &mut App) {
    APP.with(|a| *a.borrow_mut() = Some(cx.to_async()));
    if JOBS.get().is_some() {
        return;
    }
    let (tx, mut rx) = unbounded::<Job>();
    if JOBS.set(tx).is_err() {
        return;
    }
    cx.spawn(async move |cx| {
        use futures_util::StreamExt;
        while let Some(job) = rx.next().await {
            // A burst of jobs (several commits, a decoded image) is run in
            // one update, with one flush.
            let mut jobs = vec![job];
            while let Ok(job) = rx.try_recv() {
                jobs.push(job);
            }
            cx.update(|cx| {
                for job in jobs {
                    job();
                }
                flush(cx);
            });
        }
    })
    .detach();
}

/// Gives a headless test its own async app without installing a process-wide
/// queue that another test's engine threads could wake on its test scheduler.
#[cfg(test)]
pub(crate) fn init_test_app(cx: &mut App) -> impl Drop + use<> {
    struct Restore(Option<AsyncApp>);
    impl Drop for Restore {
        fn drop(&mut self) {
            APP.with(|a| *a.borrow_mut() = self.0.take());
        }
    }
    Restore(APP.with(|a| a.borrow_mut().replace(cx.to_async())))
}

/// Runs `f` on the main thread, soon (in order with other calls).
pub(crate) fn invoke(f: impl FnOnce() + Send + 'static) {
    match JOBS.get() {
        Some(tx) => {
            let _ = tx.unbounded_send(Box::new(f));
        }
        None => log::warn!("nsh-platform-gpui: invoke before init"),
    }
}

/// Runs `f` on this (main) thread after `ms` milliseconds.
pub(crate) fn after_ms(ms: u64, f: impl FnOnce() + 'static) {
    let app = APP.with(|a| a.borrow().clone());
    let Some(app) = app else {
        log::warn!("nsh-platform-gpui: timer before init");
        return;
    };
    let timer = app.background_executor().timer(Duration::from_millis(ms));
    app.spawn(async move |cx| {
        timer.await;
        cx.update(|cx| {
            f();
            flush(cx);
        });
    })
    .detach();
}

/// Runs `f` on this (main) thread, soon, outside GPUI's app (not in an
/// update): for system calls that report back to GPUI at once (a window's
/// frame changed or it moved: GPUI's resize, move and display callbacks
/// update the app), which GPUI drops while the app is being updated. Calls
/// run in order, after the update under way and with GPUI's own deferred
/// resizes and zooms. Before `init` there is no window to act on, so `f` is
/// dropped with a warning, as the other helpers here do.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
pub(crate) fn outside_app(f: impl FnOnce() + 'static) {
    let app = APP.with(|a| a.borrow().clone());
    let Some(app) = app else {
        log::warn!("nsh-platform-gpui: app call before init");
        return;
    };
    app.spawn(async move |_| f()).detach();
}

/// Runs `f` with the app on this (main) thread, soon: for what needs GPUI's
/// app where only a surface is at hand (the clipboard, closing a window).
pub(crate) fn on_app(f: impl FnOnce(&mut App) + 'static) {
    let app = APP.with(|a| a.borrow().clone());
    let Some(app) = app else {
        log::warn!("nsh-platform-gpui: app call before init");
        return;
    };
    app.spawn(async move |cx| {
        cx.update(|cx| {
            f(cx);
            flush(cx);
        });
    })
    .detach();
}

/// Notifies the views of every surface of this thread that changed since
/// they were last drawn.
pub(crate) fn flush(cx: &mut App) {
    crate::surface::flush_all(cx);
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, rc::Rc};

    /// A web view is built in `outside_app` on Windows (#2110): WebView2
    /// pumps messages while it builds, and the pending foreground tasks it
    /// runs update the app. So what `outside_app` runs must be able to
    /// update the app, though it was asked for during one (a prepaint).
    #[gpui::test]
    fn outside_app_runs_where_the_app_can_be_updated(cx: &mut gpui::TestAppContext) {
        let updated = Rc::new(Cell::new(false));
        let _app = cx.update(|cx| {
            let app = super::init_test_app(cx);
            let async_app = cx.to_async();
            let ran = updated.clone();
            super::outside_app(move || {
                // A nested message pump running a pending foreground task.
                async_app.update(|_| ran.set(true));
            });
            assert!(!updated.get(), "ran inside the update");
            app
        });
        cx.run_until_parked();
        assert!(updated.get());
    }
}
