# c2-calls-lab: fake media devices and a loopback call in Playwright Chromium and WebKit

Evidence for the calls design in [SEEDING-AND-ZERO-SETUP-DESIGN.md](../../v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), section 3.5.
Run from the repository root: `node docs/research/labs/c2-calls-lab/probe.mjs "$PWD"`. Every URL is
`http://127.0.0.1:<port>`; Chromium runs with `chromiumArgs()`; peer connections use `iceServers: []`.

**Safety rule found while writing this lab:** `--use-fake-ui-for-media-stream` without
`--use-fake-device-for-media-stream` makes Chromium grant the machine's real camera and microphone. Always pass both.

Measured 2026-10-20 on macOS (Apple silicon), Playwright 1.64.1, Chromium 156.0.8078.4, WebKit 27.2
(`results-2026-10-20.json`):

| Item | Chromium 156 | WebKit 27.2 |
|---|---|---|
| Capture devices | fake: "Fake Default Audio Input", "fake_device_0" (640x360) | mock: "Mock audio device 1", "Mock video device 1"; context permissions `camera`, `microphone` |
| `getDisplayMedia` | fake monitor 1280x720 without a gesture | from a trusted click (`page.click`): "Mock screen device 1"; from script with a second page of the same browser open: "InvalidStateError: getDisplayMedia must be called from a user gesture handler." (a separate check outside this script, one fresh page per browser, also succeeded without a click 3 of 3: do not rely on it) |
| Second capturing page in the same browser | both capture | the first page's audio and video tracks fire `mute` and stay muted: run one browser per participant |
| Loopback call, audio + video, 4 s | connected, DTLS connected, about 9.7 KB audio and 116 to 121 KB video each way | connected (two browsers), about 16 KB audio and 136 to 140 KB video each way |
| Default send targets (`targetBitrate`) | audio 32,000 bit/s, video 1,700,000 bit/s | same |
| `setParameters` maxBitrate 150,000, scaleResolutionDownBy 2; `replaceTrack(null)` | applied; ok | applied; ok |
| SDP sizes, audio + video + one data channel (offer before and after gathering / answer) | 5,734 and 7,135 / 5,440 and 5,665 bytes | 5,898 and 6,304 / 5,624 and 5,787 bytes |
| Media Session `togglemicrophone`, `togglecamera` / `hangup`, `enterpictureinpicture` | ok / ok | ok / TypeError |
| Document Picture-in-Picture; `navigator.audioSession` | present; absent | absent; present |

Loopback numbers say nothing about real networks or phones; the real-device rows are G-CL-1 to G-CL-9.
