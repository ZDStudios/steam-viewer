# Steam Viewer Host

The companion that runs on the PC your Steam library lives on, so the website can list what you have
installed, start a game, and hand the stream to Moonlight or Steam Remote Play.

## Why it exists

A web page cannot read a local Steam install, launch a program, or open a video stream from your
desktop. Browsers forbid all three — that is a security boundary, not a missing feature. So the part
that *is* allowed to do those things runs on your machine, and the page talks to it:

```
 this page (github.io)  ──http──►  127.0.0.1:8777  ──►  steam://rungameid/…
                                   (this program)   └─►  Sunshine → Moonlight
```

## Running it

Node 18 or newer. No `npm install` — the script has no dependencies.

```bash
node steam-viewer-host.mjs
```

It prints a pairing code:

```
  Steam Viewer Host
  ─────────────────────────────────────────────
  listening   http://127.0.0.1:8777
  machine     DESKTOP-4F2 (win32)
  steam       2 library folder(s), 137 installed game(s)

  PAIRING CODE:  K7QM4X
```

Open Steam Viewer **on that same PC**, go to **Remote Play**, and type the code in. That browser is
then remembered; you only do it once.

| Flag | What it does |
| --- | --- |
| `--port 8778` | Listen somewhere else. The page probes 8777, 8778 and 8779. |
| `--allow-lan` | Also listen on your LAN, so another device in the house can drive it. Still needs pairing, and still refuses anything from outside a private address range. |
| `--token <s>` | Use a fixed token and skip pairing entirely — for a machine you control end to end. |
| `--code <s>` | Use a fixed pairing code instead of a random one. |

If Steam is somewhere unusual, point at it:

```bash
STEAM_PATH="D:\Steam" node steam-viewer-host.mjs
```

## Streaming

The agent reports what it finds; the page offers whichever is available.

- **Moonlight** — install [Sunshine](https://github.com/LizardByte/Sunshine/releases) on this PC. The
  agent notices it on ports 47989/47990 and the page offers a `moonlight://` link that opens the
  native Moonlight client on whatever you are playing from.
- **Steam Remote Play** — nothing extra to install. Start the game from the page, then connect with
  the Steam Link app on your phone, tablet, TV or another PC.

Neither streams video *into the web page itself* — both hand off to a native client, because that is
how low-latency game streaming actually works. What the page gives you is the library, the launch,
and the handoff.

## Browser support

Talking to `127.0.0.1` from an `https://` page is allowed in **Chrome, Edge and Firefox** — loopback
counts as a trustworthy origin. **Safari blocks it**, so use one of the others for Remote Play. The
rest of the site is fine in Safari.

## What it will and will not do

- Listens on `127.0.0.1` only, unless you pass `--allow-lan`.
- Answers nothing until a browser has traded the pairing code for a token, and compares tokens in
  constant time.
- Launches exactly one kind of thing: `steam://rungameid/<number>`, and only for a number that
  appears in the app manifests on this machine. It never runs an arbitrary path, and never goes
  through a shell.
- Sends nothing anywhere. It answers the browser on your own machine; that is the whole of its
  network activity.
- Cannot stop a running game — Steam has no remote-stop command, and killing a game process from a
  web page is not something this should be doing.

Stop it with Ctrl-C. Nothing is left running, and nothing is installed.
