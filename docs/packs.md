# Button packs

A button pack changes how Ploink looks and sounds: the caps, the ring around them, the LED ring, the readout, the panel, the activity log, the sounds, the launch and result effects, and a few words. Packs only change looks and sounds. Your deploys work the same with every pack.

Click the LED ring button in the top bar to open **Button packs**. Click a pack to try it on your bays.

## Packs that come with Ploink

| Pack | In |
|---|---|
| Mission Control (the default) | Free, in this repo |
| Quiet Office | Free, in this repo |
| Arcade, Synthwave, Cockpit, 70s Hi-Fi, Santa's Workshop, Power Play | Ploink Pro, in the official build |

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
| `cap.material` | `gloss` (default), `concave`, `matte`, `glass`, `metal`, `puck`, `ornament` |
| `cap.palette` | Up to 6 `#rrggbb` colours, used for the caps in turn. If you leave it out, each project keeps its own colour |
| `bezel.style` | `steel` (default), `black`, `brass`, `chrome`, `neon` |
| `led.style` | `dots` (default), `segments`, `comet`, `bulbs` |
| `led.palette` | Up to 4 colours for `bulbs` |
| `readout.style` | `vfd` (default), `seven-seg`, `dot-matrix`, `backlit` |
| `panel.style` | `plain` (default), `wood`, `grid`, `scanlines`, `rink`, `frost`, `hazard` |
| `log.style` | The activity log's paper: `receipt` (default, cream thermal paper), `terminal` (a dark screen in the pack's readout colours), `ledger` (a ruled notebook page), `parchment` (an old scroll), `jcard` (a cassette insert) or `scoresheet` (a hockey game sheet) |
| `effects.launch`, `effects.success`, `effects.fail` | `kind`: `ignite`, `confetti`, `pixels`, `sweep`, `flash`, `snow`, `goal`, `runway`, `fizzle` or `none`. Optional `palette` (up to 8 colours), `count` (1 to 200) and `size` (0.5 to 2) |
| `words` | New text for the readout states `READY`, `IGNITION`, `IN FLIGHT`, `SHIPPED`, `FAILED`, `ABORTED` and `IDLE`, for the activity log's name (`FLIGHT LOG`) and for its filters (`ALL`, `AGENT`; the failures filter uses `FAILED`). At most 14 letters, digits or simple punctuation |

Tokens a pack may set: `--chassis`, `--chassis-top`, `--chassis-bot`, `--topbar-top`, `--topbar-bot`, `--plate`, `--plate-hi`, `--plate-lo`, `--hole`, `--line`, `--ink`, `--ink-2`, `--muted`, `--engrave`, `--vfd`, `--vfd-glow`, `--vfd-dim`, `--ok`, `--bad`, `--warn`, `--brand`, `--brand-lo`, `--bay-top`, `--bay-mid`, `--bay-bot`, `--led-off`, `--lcd-1`, `--lcd-2`, `--screw`.

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
