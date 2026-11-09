#!/usr/bin/env bash
# The phone app's native part (android/src): the microphone behind the console's `morph.voice.*`
# host calls, which nsh's prebuilt Android runtime does not have. build-android.sh compiles it into
# the APK's classes.dex next to the runtime's own classes; MorphApplication (named in the manifest
# by scripts/android-manifest.mjs) attaches it to nsh's AppActivity.
#
#   scripts/android-host.sh dex RUNTIME_DEX NSH_AAR ANDROID_JAR BUILD_TOOLS OUT_DIR
#       OUT_DIR/classes.dex: RUNTIME_DEX (nsh's runtime/android/release/classes.dex) with these
#       classes, compiled against ANDROID_JAR and NSH_AAR's classes.
#   scripts/android-host.sh test
#       The JVM tests (android/test) of the parts that need no Android: the recording's states,
#       permission outcomes, cleanup and the upload.
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

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

case "${1:-}" in
  dex)
    [[ $# -eq 6 ]] || { echo "usage: $0 dex RUNTIME_DEX NSH_AAR ANDROID_JAR BUILD_TOOLS OUT_DIR" >&2; exit 1; }
    runtime_dex=$2 aar=$3 android_jar=$4 build_tools=$5 out=$6
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
    "$build_tools/d8" --release --min-api 28 --lib "$android_jar" --classpath "$work/classes.jar" \
      --output "$work/dex" "$runtime_dex" @"$work/class-files"
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
      grep -L '^import android\.\|^import com\.longbridge\.' "$src"/com/mistermorph/console/*.java
      find "$tests" -name '*.java'
    } | sort >"$work/sources"
    "${java_home_bin}javac" -encoding UTF-8 -d "$work/classes" @"$work/sources"
    "${java_home_bin}java" -cp "$work/classes" com.mistermorph.console.VoiceControllerTest
    ;;
  *)
    sed -n '2,15p' "$0"
    exit 1
    ;;
esac
