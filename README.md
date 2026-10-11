# 404-export

Load a folder of samples onto an SP-404SX SD card from the command line. The card-writing code comes from
[Super Pads](https://github.com/MatthewCallis/super-pads) (pinned in `package.json`): conversion, `PAD_INFO.BIN`
encoding, and the save-with-rollback process are the same as when you click **Write SD Card** in the app.

## Setup

Requires Node.js 24 or newer. FFmpeg comes bundled with the dependencies.

```bash
npm install
```

## Usage

```bash
node sp404-load.js ~/Music/my-kit /Volumes/SP-404SX --dry-run
```

```bash
node sp404-load.js ~/Music/my-kit /Volumes/SP-404SX
```

The second argument is the SD card root, the folder that contains `ROLAND/`. The card must already be formatted
by the sampler.

### File naming

`<anything>-<Bank><Pad>-<BPM>.<ext>`, for example `mysample-A01-140.wav` → bank A, pad 1, 140 BPM.

- Bank `A`–`J`, pad `1`–`12` (with or without a leading zero), BPM 40–200 (decimals are rounded to the nearest 0.1 BPM, which is what the card stores).
- Any format FFmpeg can read (wav, aiff, flac, mp3, …). Every file is converted to 44.1 kHz, 16-bit stereo Roland WAV.
- Files that don't match the pattern are skipped with a warning. Hidden files (`.DS_Store`, `._*`) are ignored.
- Two files for the same pad, or a BPM out of range, stop the run before anything is written.

### What gets set on each loaded pad

| Setting | Value |
|---|---|
| Loop | On |
| Volume | 127 (max) |
| Tempo Mode | User |
| Original BPM / User BPM | BPM from the filename |
| Channels | Stereo |

Pads with no matching file keep their existing samples and settings.

### Safety

The write is a Super Pads card transaction. All conversions finish and are validated before any file on the card
is replaced, and a failure rolls everything back. If a write is interrupted (for example the card is pulled out),
run the script again or open the card in Super Pads to finish recovery. Leave the `.super-pads-transaction` folder
alone until then. The script also updates `super-pads.json`, so the Super Pads app shows the same state.

## Tests

```bash
npm test
```
