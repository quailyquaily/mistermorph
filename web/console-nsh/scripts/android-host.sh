#!/usr/bin/env bash
# The phone app's native part (android/src): the microphone behind the console's `morph.voice.*`
# host calls, the task notifications behind `morph.notify.*`, the saving of files behind
# `morph.file.save*`, the app's version behind `morph.shell.info` and the hardware keyboard's state
# behind `morph.keyboard.state`, which nsh's prebuilt Android runtime does not have; and ModalKeyboardRoom (com/longbridge/nsh, in nsh's package), which takes
# back the keyboard room nsh 0.6.0 leaves under a dialog's fields; and ScrollBox, nsh 0.6.0's scroll
# view with the fix for scroll views inside scroll views (ScrollClaim: a sideways drag on a wide table
# or code block in the chat, or on the Jobs graph, is no longer cancelled by the scroll view around
# it), which replaces the runtime's own ScrollBox classes. build-android.sh compiles it into
# the APK's classes.dex next to the runtime's own classes; MorphApplication (named in the manifest
# by scripts/android-manifest.mjs) attaches it to nsh's AppActivity.
#
#   scripts/android-host.sh dex RUNTIME_DEX NSH_AAR ANDROID_JAR BUILD_TOOLS OUT_DIR NSH_VERSION
#       OUT_DIR/classes.dex: RUNTIME_DEX (nsh's runtime/android/release/classes.dex, of nsh
#       NSH_VERSION) with these classes, compiled against ANDROID_JAR and NSH_AAR's classes; the
#       runtime's own classes of the patched nsh classes are left out. Fails for another nsh version
#       than the one the patched classes come from.
#   scripts/android-host.sh test
#       The JVM tests (android/test) of the parts that need no Android: the recording's states,
#       permission outcomes, cleanup and the upload; the task notifications' watcher; saving a file
#       (the download, its failures and the cleanup after a failed save); the app's version answer; the hardware
#       keyboard's state from the input devices; who keeps a touch among scroll views inside scroll views.
#
# Needs a JDK (javac, jar, java); `dex` also the SDK's build tools (d8).
set -euo pipefail

app=$(cd "$(dirname "$0")/.." && pwd)
src="$app/android/src"
java_home_bin=""
[[ -n "${JAVA_HOME:-}" ]] && java_home_bin="$JAVA_HOME/bin/"
for tool in javac jar java; do
  if ! command -v "${java_home_bin}$tool" >/dev/null; then
    echo "a JDK is needed for the phone app's native part: $tool not found (set JAVA_HOME)" >&2
    exit 1
  fi
done

# nsh's own classes that android/src replaces (com/longbridge/nsh/<name>.java, with their nested
# classes), and the nsh release they were taken from.
patched_nsh=0.6.0
patched_classes=(ScrollBox)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

case "${1:-}" in
  dex)
    [[ $# -eq 7 ]] || { echo "usage: $0 dex RUNTIME_DEX NSH_AAR ANDROID_JAR BUILD_TOOLS OUT_DIR NSH_VERSION" >&2; exit 1; }
    runtime_dex=$2 aar=$3 android_jar=$4 build_tools=$5 out=$6 nsh_version=$7
    if [[ "$nsh_version" != "$patched_nsh" ]]; then
      echo "android/src patches nsh $patched_nsh's Android runtime (com.longbridge.nsh: ${patched_classes[*]}), not nsh $nsh_version's:" >&2
      echo "check whether nsh $nsh_version fixed what they fix (docs/feat/feat_20261125_android_nested_scroll.md), then drop them or patch its own files" >&2
      exit 1
    fi
    for file in "$runtime_dex" "$aar" "$android_jar" "$build_tools/d8" "$build_tools/core-lambda-stubs.jar"; do
      [[ -e "$file" ]] || { echo "missing: $file" >&2; exit 1; }
    done
    # nsh's classes (NshView, NshHostReply) to compile against; the runtime's dex has them.
    (cd "$work" && "${java_home_bin}jar" xf "$aar" classes.jar)
    mkdir -p "$work/classes" "$work/dex"
    find "$src" -name '*.java' | sort >"$work/sources"
    # Java 8 bytecode against the platform's android.jar (and the build tools' lambda stubs, which
    # it lacks); d8 desugars the lambdas.
    "${java_home_bin}javac" -source 8 -target 8 -Xlint:-options -encoding UTF-8 \
      -bootclasspath "$android_jar:$build_tools/core-lambda-stubs.jar" -classpath "$work/classes.jar" \
      -d "$work/classes" @"$work/sources"
    find "$work/classes" -name '*.class' | sort >"$work/class-files"
    # The runtime's classes one dex each, less those of the patched classes (theirs and their nested
    # and synthetic classes), whose place the app's take.
    mkdir -p "$work/runtime"
    "$build_tools/d8" --release --min-api 28 --lib "$android_jar" --file-per-class --output "$work/runtime" "$runtime_dex"
    for name in "${patched_classes[@]}"; do
      nsh_dir="$work/runtime/com/longbridge/nsh"
      if [[ ! -f "$nsh_dir/$name.dex" || ! -f "$work/classes/com/longbridge/nsh/$name.class" ]]; then
        echo "the runtime ($runtime_dex) or android/src has no com.longbridge.nsh.$name to replace" >&2
        exit 1
      fi
      # Every named nested class of the runtime's (ScrollBox$VScroll) has one of the app's in its
      # place. Anonymous and synthetic ones (ScrollBox$1, ScrollBox$$ExternalSyntheticLambda0,
      # ScrollBox$0 and ScrollBox-IA from older d8s) are the compiler's: they go with their class.
      for nested in "$nsh_dir/$name\$"*.dex; do
        [[ -e "$nested" ]] || continue
        nested=$(basename "$nested" .dex)
        [[ "$nested" =~ \$[0-9]|\$\$ ]] && continue
        if [[ ! -f "$work/classes/com/longbridge/nsh/$nested.class" ]]; then
          echo "the runtime's com.longbridge.nsh.$nested has no counterpart in android/src: is it nsh $patched_nsh's?" >&2
          exit 1
        fi
      done
      rm -f "$nsh_dir/$name.dex" "$nsh_dir/$name\$"*.dex "$nsh_dir/$name-"*.dex
    done
    find "$work/runtime" -name '*.dex' | sort >"$work/runtime-files"
    "$build_tools/d8" --release --min-api 28 --lib "$android_jar" --classpath "$work/classes.jar" \
      --output "$work/dex" @"$work/runtime-files" @"$work/class-files"
    # nsh packages one classes.dex: the merged code must fit in it.
    if [[ "$(ls "$work/dex")" != classes.dex ]]; then
      echo "the runtime and the native part no longer fit in one classes.dex: $(ls "$work/dex" | tr '\n' ' ')" >&2
      exit 1
    fi
    mkdir -p "$out"
    cp "$work/dex/classes.dex" "$out/classes.dex"
    ;;
  test)
    # Only the classes without Android imports: the rest is compiled by `dex`.
    tests="$app/android/test"
    mkdir -p "$work/classes"
    {
      grep -L '^import android\.\|^import com\.longbridge\.' "$src"/com/mistermorph/console/*.java "$src"/com/longbridge/nsh/*.java
      find "$tests" -name '*.java'
    } | sort >"$work/sources"
    "${java_home_bin}javac" -encoding UTF-8 -d "$work/classes" @"$work/sources"
    "${java_home_bin}java" -cp "$work/classes" com.mistermorph.console.VoiceControllerTest
    "${java_home_bin}java" -cp "$work/classes" com.mistermorph.console.TaskNotifierTest
    "${java_home_bin}java" -cp "$work/classes" com.mistermorph.console.FileSaverTest
    "${java_home_bin}java" -cp "$work/classes" com.mistermorph.console.ShellInfoTest
    "${java_home_bin}java" -cp "$work/classes" com.mistermorph.console.HardwareKeyboardTest
    "${java_home_bin}java" -cp "$work/classes" com.longbridge.nsh.ScrollClaimTest
    ;;
  *)
    sed -n '2,24p' "$0"
    exit 1
    ;;
esac
