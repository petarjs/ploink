# Button packs

A button pack changes how Ploink looks and sounds: the caps, the ring around them, the LED ring, the readout, the panel, the activity log, the sounds, the launch and result effects, and a few words. Packs only change looks and sounds. Your deploys work the same with every pack.

Click the LED ring button in the top bar to open **Button packs**. Click a pack to try it on your bays.

## Packs that come with Ploink

| Pack | In |
|---|---|
| Mission Control (the default), Quiet Office, Whitespace | Free, in this repo |
| Arcade, Synthwave, Cockpit, 70s Hi-Fi, Santa's Workshop, Power Play | Ploink Pro, in the official build |
| Sheet Happens, Root Access, Sublevel 9, Fresh Install, Bug Jar, Party Line, Hard Shadow, Boilerplate, Wetware, Under Construction, Thumbprint, Haberdashery, Stop Press, Rubber Ducking, Mercury Retrograde, Meniscus, Xenoglyph, Primitives | Ploink Pro 0.3.0, in the official build |

The pack format and every building block are MIT, like the rest of this repo. Anyone can make a pack.

## Make your own pack

A pack is one JSON file with the extension `.ploinkpack`, at most 64 KB. To install a pack, drop the file on the Ploink window. Ploink copies it into its data folder and switches to it. To remove a community pack, click the × on its tile.

```json
{
  "format": 1,
  "id": "com.you.neon",
  "name": "Neon",
  "version": "1.0.0",
  "author": "You",
  "description": "One sentence for the tooltip.",
  "tokens": { "--vfd": "#ff3df2", "--bay-top": "#1d0b35" },
  "cap": { "material": "glass", "palette": ["#ff3df2", "#3df5ff"] },
  "bezel": { "style": "neon" },
  "led": { "style": "comet" },
  "readout": { "style": "vfd" },
  "panel": { "style": "grid" },
  "log": { "style": "terminal" },
  "sounds": {
    "success": [
      { "kind": "tone", "type": "sawtooth", "freq": 440, "decay": 0.25, "peak": 0.05, "echo": true },
      { "kind": "tone", "type": "sawtooth", "freq": 659.25, "at": 0.08, "decay": 0.4, "peak": 0.05, "echo": true }
    ],
    "launch": null
  },
  "effects": { "success": { "kind": "sweep", "palette": ["#ff3df2", "#3df5ff"] } },
  "words": { "SHIPPED": "OUTRUN", "FAILED": "GLITCH", "FLIGHT LOG": "TRANSMISSIONS" }
}
```

Only `format`, `id` and `name` are required. Everything you leave out uses the Mission Control default.

### Rules

1. A pack contains no code and no web addresses. Each building block must be one of the names below. An unknown name falls back to the default, and Ploink tells you which part it skipped.
2. `id` uses lowercase letters, digits, dots and dashes, for example `com.you.neon`. Ids that start with `dev.ploink.` are reserved for official packs.
3. Token values must be a colour (`#hex`, `rgb()`, `hsl()`), a length (`px`, `%`, `em`, `rem`) or a number.
4. Sound numbers are clamped: frequency 20 to 12,000 Hz, `peak` at most 0.6, each step ends within 3 seconds, and each sound has at most 16 steps.

### Building blocks

| Part | Values |
|---|---|
| `surface` | `dark` (default) or `light`. Use `light` for packs with a pale chassis: shadows get softer and dark text glow goes away. Set the light colours with tokens (see below) |
| `cap.material` | `gloss` (default), `concave`, `matte`, `glass`, `metal`, `puck`, `ornament`, `flat` (solid fill, black outline, hard shadow; pressing slides into the shadow), `droplet` (a clear lens that bulges while you hold), `clay` (squashes while you hold), `membrane` (translucent, breathing), `sewn` (a four-hole button; the thread tightens as you hold and snaps on a failure), `duck` (a bath duck wearing the project icon as a badge) |
| `cap.shape` | `round` or `square` decide the button outline for every project. A solid, or a list of solids used in turn per project: `sphere`, `cube`, `cylinder`, `cone`, `torus`, `icosahedron`. Solids follow your cursor and tumble while deploying. Leave it out to keep the user's setting |
| `cap.palette` | Up to 6 `#rrggbb` colours, used for the caps in turn. If you leave it out, each project keeps its own colour |
| `bezel.style` | `steel` (default), `black`, `brass`, `chrome`, `neon`, `outline` (a plain stroke), `bevel` (a grey 3D frame), `dimple` (a pressed hollow) |
| `led.style` | `dots` (default), `segments`, `comet`, `bulbs`, `gauge` (a dial whose needle sweeps into the red while you hold), `arc` (one thin line drawn round the cap; orange after a failure), `orbit` (the ring laid flat as an ellipse) |
| `led.palette` | Up to 4 colours for `bulbs` |
| `readout.style` | `vfd` (default), `seven-seg`, `dot-matrix`, `backlit`, `terminal` (block cursor, typed status; while you hold, it brute-forces the project name), `frosted` (a blurred glass pill), `marquee` (a scrolling ticker), `glyph` (an invented script that translates while your cursor is over the bay), `crt` (curved glass and a little flicker) |
| `panel.style` | `plain` (default), `wood`, `grid`, `scanlines`, `rink`, `frost`, `hazard`, `cells` (a spreadsheet), `aurora` (slow colour behind glass bays), `hud` (cut corners, barcodes, serial labels), `starfield`, `window` (every bay is a small window), `studio` (a photo backdrop, no plates), `linen`, `tiles` |
| `log.style` | The activity log's paper: `receipt` (default), `terminal`, `ledger`, `parchment`, `jcard`, `scoresheet`, `worksheet` (sheet tabs and a SUM / AVERAGE / COUNT status bar), `frosted`, `card`, `dispatch`, `hud`, `minimal`, `guestbook` (with a hit counter), `window`, `clay`, `membrane`, `scene`, `dossier` (agents are redacted until you hover), `sampler`, `pinboard` (every failure becomes a generated beetle with a Latin name), `newspaper` (headlines written from your deploys), `slips` (agent events arrive as WHILE YOU WERE OUT slips), `mirror`, `tarot` |
| `effects.launch`, `effects.success`, `effects.fail` | `kind`: `ignite`, `confetti`, `pixels`, `sweep`, `flash`, `snow`, `goal`, `runway`, `fizzle`, `rain` (the deploy command's characters falling in columns), `steam`, `glitch` (the console tears for a moment), `dialogs` (an error box with an OK button; they cascade), `spores`, `fireflies`, `bubbles` or `none`. Optional `palette` (up to 8 colours), `count` (1 to 200) and `size` (0.5 to 2) |
| `quips` | Up to 40 ticker lines a bay shows for a few seconds. Each is `{ "on": "hold" | "launch" | "success" | "fail", "text": "..." }` with at most 60 characters, plus optional `days` (0 = Sunday to 6), `hours` (`[from, to]`, local time) and `chance` (0 to 1) |
| `words` | New text for the readout states `READY`, `IGNITION`, `IN FLIGHT`, `SHIPPED`, `FAILED`, `ABORTED` and `IDLE`, for the activity log's name (`FLIGHT LOG`) and for its filters (`ALL`, `AGENT`; the failures filter uses `FAILED`). At most 14 letters, digits or simple punctuation |

Tokens a pack may set: `--chassis`, `--chassis-top`, `--chassis-bot`, `--topbar-top`, `--topbar-bot`, `--plate`, `--plate-hi`, `--plate-lo`, `--hole`, `--hole-hi`, `--line`, `--ink`, `--ink-2`, `--muted`, `--engrave`, `--vfd`, `--vfd-glow`, `--vfd-dim`, `--ok`, `--bad`, `--warn`, `--brand`, `--brand-lo`, `--bay-top`, `--bay-mid`, `--bay-bot`, `--led-off`, `--led-trail`, `--lcd-1`, `--lcd-2`, `--screw`, `--screw-slot`.

Light packs also repaint the console's small parts with these tokens: `--key-top`, `--key-bot`, `--key-hover-top`, `--key-hover-bot`, `--key-edge` (keycaps and action keys), `--thumb-top`, `--thumb-bot` (the command selector), `--well`, `--well-top`, `--well-bot` (recessed fields and lamps), `--lamp-off`, `--strip` (the footer), `--scroll`, `--ring` (the launch bar's hole ring), `--socket`, `--socket-ring`, `--socket-ink` (the add-project socket), `--medal-1`, `--medal-2` (the disc behind the project icon). Each defaults to the classic dark value. `--tone-ok`, `--tone-bad` and `--tone-warn` set the readout colour after a deploy ships, fails or needs attention; light readouts usually need darker ones.

### Sounds

Each sound is a list of steps that play together. `at` delays a step, so a list can be a chord or a short tune. Set a sound to `null` for silence.

| Field | Meaning |
|---|---|
| `kind` | `tone` (an oscillator) or `noise` (filtered white noise) |
| `type` | For a tone: `sine`, `square`, `sawtooth` or `triangle`. For noise: `lowpass`, `highpass` or `bandpass` |
| `freq`, `to` | Start frequency in Hz, and an optional end frequency for a slide |
| `at`, `attack`, `decay` | Start delay, fade-in time and fade-out time, in seconds |
| `peak` | Loudness, 0.0002 to 0.6 |
| `detune` | Tone only, in cents |
| `q` | Noise only, filter sharpness |
| `echo` | `true` sends the step through the echo |
| `rise` | `tick` only: the pitch climbs this many octaves while you hold the button |

The sounds a pack can replace are `press`, `release`, `tick`, `launch`, `success`, `fail`, `request`, `click`, `denied`, `install`, `whoosh`, `thunk`, `boot` and `printer`.

To check a pack before you share it, run `node -e "import('./main/packs.mjs').then(m => console.log(m.parsePack(require('fs').readFileSync(process.argv[1], 'utf8'))))" your.ploinkpack` in this repo.
