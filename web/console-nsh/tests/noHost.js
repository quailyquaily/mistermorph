// `nsh test --web-host tests/noHost.js`: host.js needs a browser page; tests answer the morph.*
// calls through `open`'s `host` handlers (tests/harness.ts).
export function createHost() {
  return {
    call(name) {
      throw new Error(`test host: unstubbed ${name}`);
    },
  };
}
