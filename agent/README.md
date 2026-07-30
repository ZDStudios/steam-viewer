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
| Streams video into the browser | ❌ see below |
| Closes a running game | ❌ Steam has no protocol handler for it |

### Why the video isn't in the browser

A web page cannot decode NVIDIA GameStream (what Moonlight speaks) or Steam's
Remote Play protocol — neither has a browser client, and Valve ships no web SDK
for Steam Link. Rewriting either as WebRTC is a project in its own right.

What the agent does instead is detect a **Sunshine** host on your PC and give
the site a `moonlight://<your-ip>` link. Clicking **Stream** launches your
installed Moonlight client already pointed at the right machine, and the
**Play** button starts the game on the PC so it is ready when Moonlight opens.

To enable that path, install:

- [Sunshine](https://app.lizardbyte.dev/Sunshine/) on the gaming PC (the host)
- [Moonlight](https://moonlight-stream.org/) on whatever you are watching from

The agent looks for Sunshine on ports 47989/47990 and reports what it finds.

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

Steam is auto-detected in the usual places on Windows, macOS and Linux
(including Flatpak), and every extra library drive listed in
`libraryfolders.vdf` is scanned.
