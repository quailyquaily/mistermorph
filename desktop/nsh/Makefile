# The desktop app (GPUI shell + backend). Run from this folder or with `make -C desktop/nsh`.
OUTPUT_DIR ?= ../../bin/desktop-nsh

.PHONY: build debug run test check

# MrMorph and morph in $(OUTPUT_DIR).
build:
	cd ../.. && desktop/nsh/build.sh --output-dir $(abspath $(OUTPUT_DIR))

debug:
	cd ../.. && desktop/nsh/build.sh --debug --output-dir $(abspath $(OUTPUT_DIR))

run: build
	$(abspath $(OUTPUT_DIR))/MrMorph

test:
	cargo test

check:
	cargo build
	cargo test
