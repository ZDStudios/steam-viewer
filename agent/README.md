# Steam Viewer Agent

Runs on your gaming PC so the website can see the games you actually have
installed, launch them remotely, and hand off to Moonlight for streaming.

```bash
cd agent
npm install
npm start -- --relay https://your-service.onrender.com
```

It prints a **pairing code**. Enter that on the site under **Remote Play**.

## What it does and doesn't do

| | |
| --- | --- |
| Reads your installed games | ✅ from `steamapps/appmanifest_*.acf` — no login, no password |
| Launches a game remotely | ✅ hands `steam://rungameid/<id>` to your Steam client |
| Rescans when you install something | ✅ every 5 minutes, configurable |
| Streams the screen into the browser | ✅ built in, needs only ffmpeg |
| Streams with mouse/controller input | ✅ via [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) + Sunshine |
| Closes a running game | ❌ Steam has no protocol handler for it |

### Built-in streaming (no extra software)

If **ffmpeg** is on your PATH, the agent can stream the screen to the site on
its own — press **Start watching** on the Remote Play page. ffmpeg captures the
desktop (`gdigrab` on Windows, `avfoundation` on macOS, `x11grab` on Linux),
encodes it, and the fragments travel down the same connection the agent already
has, so there is still nothing to port-forward.

The browser says which codec it can decode and the agent encodes to match —
H.264 in fragmented MP4 normally, VP8 in WebM for browsers built without
proprietary codecs.

Roughly a second behind real time: right for watching a game, not for aiming.
There is no input forwarding on this path — it is a view of the screen. Use the
Moonlight route below to actually play.

```powershell
npm start -- --relay <url> --stream-fps 30 --stream-bitrate 8M --stream-height 1080
```

Install ffmpeg from <https://ffmpeg.org/download.html> (on Windows,
`winget install Gyan.FFmpeg` works) and make sure `ffmpeg` runs in a fresh
terminal, or pass `--ffmpeg C:\path\to\ffmpeg.exe`.

### Watching in the browser, with input (Moonlight)

Install on the gaming PC:

1. [Sunshine](https://app.lizardbyte.dev/Sunshine/) — the streaming host.
2. [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) —
   a Rust web server that forwards a Sunshine stream to a browser over WebRTC.
   Build it, run its `web-server`, and add your PC inside its own UI with the
   address `localhost`, then pair it.

The agent probes port **8080** (override with `--web-stream-port`) and reports
the address to the site, which then shows a **Stream in browser** panel and a
**Play & stream** button on every installed game — that starts the game and
opens the player.

**Give it a certificate if you want the player inline.** Steam Viewer is served
over HTTPS, and a browser will not embed a plain-`http` origin inside an
`https` page. Set `certificate` in moonlight-web-stream's `server/config.json`,
restart it, and visit it once directly to accept the certificate — after that
the player embeds in the page. Without a certificate everything still works,
the player just opens in its own tab.

If it runs on another machine or behind a reverse proxy, pass
`--web-stream-url https://host:port` (or set it in the site's Remote Play page,
which overrides whatever the agent reports).

A native [Moonlight](https://moonlight-stream.org/) client is still detected
too — the agent looks for Sunshine on ports 47989/47990 and offers a
`moonlight://` hand-off if you prefer it.

## "self-signed certificate in certificate chain"

Node ships its own list of trusted certificate authorities and **ignores the
one Windows keeps**. If antivirus or a corporate proxy inspects HTTPS traffic,
it re-signs certificates with a root that Windows trusts and Node does not —
so a perfectly valid Render URL is rejected.

The agent detects this, retries itself with `--use-system-ca` (Node 22.15+),
and if that is unavailable prints the alternatives:

```powershell
# 1. best: let Node read the Windows certificate store
npm start -- --relay https://your-service.onrender.com --use-system-ca

# 2. point at your security software's root certificate
npm start -- --relay https://your-service.onrender.com --ca C:\path\to\root.pem

# 3. last resort, skips verification
npm start -- --relay https://your-service.onrender.com --insecure
```

Turning off HTTPS/SSL scanning for the relay's hostname in that software works
too, and is the cleanest fix if you control the setting.

## Security

The pairing code is the only credential — **anyone who has it can list and
launch games on this PC.** A fresh random code is generated on every start;
pin one with `--code` only if you understand that.

- No inbound ports are opened. The agent dials out to the relay.
- The relay never sees your Steam credentials; it only forwards operations.
- `--no-launch` runs read-only: the library is visible, launches are refused.
- Stop the agent and the pairing dies with it.

## Options

| Flag | Meaning |
| --- | --- |
| `--relay <url>` | Relay to connect to (required) |
| `--code <CODE>` | Pin the pairing code instead of generating one |
| `--steam-root <path>` | Steam directory, if auto-detection misses it |
| `--no-launch` | Read-only mode |
| `--refresh-seconds <n>` | Library rescan interval (default 300, minimum 60) |
| `--stream=false` | Disable built-in streaming |
| `--ffmpeg <path>` | ffmpeg binary, if not on PATH |
| `--stream-fps <n>` | Capture frame rate (default 30) |
| `--stream-bitrate <r>` | Video bitrate, e.g. `8M` (default 6M) |
| `--stream-height <n>` | Scale down to this height (default 1080) |
| `--stream-display <s>` | Capture source override |
| `--web-stream-port <n>` | Port moonlight-web-stream listens on (default 8080) |
| `--web-stream-url <url>` | Its address, if it runs elsewhere or behind a proxy |
| `--ca <path>` | Extra CA certificate to trust (PEM) |
| `--insecure` | Skip certificate verification. Last resort |

Steam is auto-detected in the usual places on Windows, macOS and Linux
(including Flatpak), and every extra library drive listed in
`libraryfolders.vdf` is scanned.
