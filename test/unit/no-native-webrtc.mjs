// Unit tests that load webtorrent or bittorrent-tracker/client in Node, without the native WebRTC binding.
// Both packages import @thaunknown/simple-peer, which imports webrtc-polyfill, whose Node entry loads the
// native binding of node-datachannel. Install scripts never run (.npmrc: ignore-scripts=true; package.json
// allowScripts: node-datachannel false), so a clean `npm ci` has no binding and the import throws
// "Cannot find module ../../../build/Release/node_datachannel.node". The paths under test run in browsers,
// where the binding is never used, and the Node tests use plain TCP or trackers with numwant 0, so they need
// no WebRTC at all. Importing this module first replaces webrtc-polyfill, in this test process only (node --test
// runs each file in its own process), with stubs whose constructors throw: a test that reaches WebRTC fails
// loudly instead of passing by accident. Import the WebRTC-dependent packages AFTER this module, with a
// dynamic import, because static imports are resolved before any module body runs.
import module from 'node:module';

const STUB_SOURCE = [
  'const missing = (name) => class { constructor () { throw new Error(name + " is not available: the unit tests stub WebRTC (test/unit/no-native-webrtc.mjs)") } };',
  'export const RTCPeerConnection = missing("RTCPeerConnection");',
  'export const RTCSessionDescription = missing("RTCSessionDescription");',
  'export const RTCIceCandidate = missing("RTCIceCandidate");',
  'export default { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate };',
].join('\n');

export const WEBRTC_STUB_URL = 'data:text/javascript,' + encodeURIComponent(STUB_SOURCE);

if (typeof module.registerHooks === 'function') {
  // Node 22.15+ and 23.5+: synchronous, in-thread hooks.
  module.registerHooks({
    resolve (specifier, context, nextResolve) {
      if (specifier === 'webrtc-polyfill') return { url: WEBRTC_STUB_URL, format: 'module', shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
} else {
  // Older Node 22: the same redirect as an off-thread resolve hook.
  const hooks = 'export async function resolve (specifier, context, nextResolve) {' +
    ' if (specifier === "webrtc-polyfill") return { url: ' + JSON.stringify(WEBRTC_STUB_URL) + ', format: "module", shortCircuit: true };' +
    ' return nextResolve(specifier, context); }';
  module.register('data:text/javascript,' + encodeURIComponent(hooks));
}
