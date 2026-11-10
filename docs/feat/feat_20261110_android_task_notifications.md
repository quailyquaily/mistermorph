---
date: 2026-11-10
title: Task notifications in the Android app
status: implemented
---

# Task notifications in the Android app

## Goal

The web console notifies when a task in one of the person's topics finishes or fails while its tab is in
the background (Settings → System → Topic task notifications). The Android app should do the same while it
is not in the foreground, with the same option, the same content and the same exclusions.

## Why the page cannot do it

The web console hears completions over its notification socket (`/api/notifications/ws`), which lives in
the page. In the Android app the page is the nsh app inside nsh's `AppActivity`; Android suspends it when
the activity stops, and ends the process when it needs the memory. A socket in the page would only work
while the app is in front, which is when no notification is shown. nsh 0.4.0 also has no notification API.

A push service (Firebase Cloud Messaging) would need a Google project, its credentials on every console
server and Google Play services on the phone; a console is usually a single machine on a home network
with no such account. So the app does not use one.

## How it works

The app's own Java (`web/console-nsh/android/src`, compiled into the APK by
`scripts/build-android.sh`, as voice input is) does the work outside the page:

- `TaskNotifier` (plain Java, tested on the JDK) keeps the server's API address, the session's token and
  the texts in the app's language, which the console sends it (`morph.notify.configure`) whenever the
  session or the language changes. Signing out sends an empty token, which stops everything.
- When `AppActivity` stops (the person leaves the app, or the screen goes off), and the person is signed
  in and allows notifications, it schedules `TaskNotifierJob`, a JobScheduler job that needs a network.
  When the activity starts again it cancels the job.
- The job asks the console `GET /api/notifications/events` with the session's token. The first request
  asks for the completions since the app left (`since_ms`, measured on the phone's own clock, so the
  phone's and the server's clocks are never compared); later ones ask for those after the last answer's
  cursor and wait on the server up to 50 seconds for the next one. Each new completion becomes a
  notification: the topic's name (read through `/api/proxy`, three seconds at most, else the untitled
  label, never the topic's ID) and "Task finished" or "Task failed".
- While the server reports chat tasks queued or running (`active`) the job keeps asking, handing over
  to a new job every 8 minutes (Android stops a job after 10). With nothing running it checks again
  every 15 minutes. After 24 hours away it stops until the app is opened again. An unreachable server
  is tried again after 30 s, doubling up to 15 minutes. An ended session (401) or a console without
  the route (an older server) stops it.
- Each completion is told at most once per device: the IDs of the last 128 are kept in the app's
  private preferences, so a server restart (whose answers fall back to the time away) or a restarted
  job does not repeat one. A completion that arrives after the app came back to the front is not
  shown, and not shown later either, as on the web.
- Pressing a notification starts `NotificationOpenActivity`, which keeps the topic and brings the app
  to the front (starting it if needed). The console takes the topic (`morph.notify.take`) at start
  and when told the app came back (`morph.notify.opened`), checks that it still exists, and opens it,
  or the chat when it is gone or cannot be read. Signed out, nothing opens.
- The page's own topic notification handler steps aside in the app, so a completion is never told by
  both.

The server keeps the completions for this in memory (`taskCompletionLog` in
`cmd/mistermorph/consolecmd/notification_events.go`): the same events the socket sends, recorded when
they are published. There is no configuration.

## Permission

The notifications row in Settings → System asks through the native part (`morph.notify.state` and
`morph.notify.request`). On Android 13 and newer it asks for `POST_NOTIFICATIONS` from a transparent
activity over the app; after a refusal the button stays and the system asks again, and once Android stops
asking the row says to allow notifications in the system settings. On older versions notifications are
allowed unless they were turned off. Turning the app's notifications, or its "Topic task notifications"
channel, off in the system settings stops the watch at its next request. The app never asks by itself.

## Limits

- Delivery is not instant in every case. JobScheduler runs the job when Android allows: Doze and app
  standby (an app not opened for a long time) delay it, up to a maintenance window. Typically a
  notification follows the completion within seconds while the phone is awake.
- After Android ends the app's process, the scheduled job still runs and starts it again without
  showing anything. After a force stop ("Force stop" in the app's info, or some vendors' task killers)
  Android cancels the job: nothing is told until the app is opened again. A phone restart also cancels
  it. Swiping the app away from the recent apps keeps the job on stock Android; some vendors' systems
  treat it as a force stop.
- The watch ends 24 hours after the app left, and while signed out or with notifications not allowed.
- The phone has to reach the console server: on the local network, away from it the console is not
  reachable and the job keeps retrying (at most every 15 minutes).
- The console's session must stay valid (`console.session_ttl`, 7 days by default); after it ends the
  watch stops until the person signs in again in the app.
- Only the Android app. nsh's iOS host has no such native part, and iOS allows no comparable background
  work without a push service.
- TODO items' opt-in notifications are not shown in the app yet.

## Checks

- `go test ./cmd/mistermorph/consolecmd/ -run 'TaskCompletion|NotificationEvents'`: the log, its
  exclusions, `active`, the cursor and since reads, the wait and the session check.
- `web/console-nsh/scripts/android-host.sh test`: `TaskNotifierTest`, the watcher on the JDK against a
  local HTTP server: once per device, foreground suppression, exclusions, permission and sign-out,
  ended sessions, retries, untitled topics, process restarts, the job's pacing.
- `node --test web/console-nsh/scripts/android-manifest.test.mjs`: the permission, activities and job in
  the APK's manifest.
- `nsh test tests/android-notifications.test.tsx` and `tests/background-task-notifications.test.tsx`
  (in `web/console-nsh`, with `--web-host tests/noHost.js`): configuration, the Settings row, pressed
  notifications (also of a deleted topic), and the page stepping aside.
- Not checked on a device: no Android device or emulator was available when this was built, so the real
  permission dialog, the job under Doze, terminated-process delivery and pressing a notification are
  unverified.
