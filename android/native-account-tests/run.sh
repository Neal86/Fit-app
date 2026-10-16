#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/fitflow-native-core.XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
SRC="$ROOT/app/src/main/java/com/fitflow/app/accounts"
# The installed JDK module provides a compiler even when a javac executable is absent.
# Production-only dependency-free core; no Android or transport mocks are compiled.
java -m jdk.compiler/com.sun.tools.javac.Main -source 8 -target 8 -Xlint:all,-options -d "$OUT" \
  "$SRC/NativeAccountPolicy.java" "$SRC/StrictJson.java" \
  "$SRC/NativeAccountProtocol.java" "$SRC/NativeAccountState.java" \
  "$ROOT/native-account-tests/NativeAccountCoreTest.java" \
  "$ROOT/native-account-tests/IndependentReviewTest.java"
java -ea -cp "$OUT" com.fitflow.app.accounts.NativeAccountCoreTest
java -ea -cp "$OUT" com.fitflow.app.accounts.IndependentReviewTest
python3 "$ROOT/native-account-tests/check-source.py"
