#!/usr/bin/env node
/**
 * Load a folder of samples onto an SP-404SX SD card without the Super Pads UI.
 *
 * Files named `<anything>-<Bank><Pad>-<BPM>.<ext>` (e.g. `mysample-A01-140.wav`) are assigned to that pad.
 * Every sample is converted to a 44.1 kHz, 16-bit stereo Roland WAV, and its pad is set to loop at volume 127
 * with Tempo Mode "User" and both the original and user BPM taken from the filename.
 *
 * The card write itself is Super Pads' `writeCard`: conversions are staged, validated, and committed with a
 * recovery journal, so a failed run leaves the card as it was. Pads without a matching file are untouched.
 */
const fs = require('node:fs');
const path = require('node:path');
const { decodePads } = require('super-pads/src/padMetadata');
const { recoverCard, SAMPLE_DIRECTORY } = require('super-pads/src/cardTransaction');
const { readPatterns } = require('super-pads/src/readPatterns');
const writeCard = require('super-pads/src/writeCard');

/** The SP-404SX accepts user tempos from 40 to 200 BPM. */
const MIN_BPM = 40;
const MAX_BPM = 200;

/** Settings applied to every loaded pad. */
const PAD_SETTINGS = { loop: true, volume: 127, tempoMode: 'User', channels: 'Stereo' };

const NAME_PATTERN = /-([A-J])(0?[1-9]|1[0-2])-(\d+(?:\.\d+)?)\.[^.]+$/i;

/** Return `{ label, bpm }` for a matching filename, or undefined. BPM is rounded to the card's tenths. */
function parseSampleName(filename) {
  const match = NAME_PATTERN.exec(filename);
  if (!match) return undefined;
  const label = `${match[1].toUpperCase()}${Number.parseInt(match[2], 10)}`;
  const bpm = Math.round(Number.parseFloat(match[3]) * 10) / 10;
  return { label, bpm };
}

/**
 * Scan a folder and decide which file goes on which pad.
 * Returns `{ assignments, skipped, errors }`; any error means nothing should be written.
 */
function planLoad(folder) {
  const assignments = [];
  const skipped = [];
  const errors = [];
  const byLabel = new Map();
  const entries = fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of entries) {
    const parsed = parseSampleName(name);
    if (!parsed) {
      skipped.push(name);
      continue;
    }
    if (parsed.bpm < MIN_BPM || parsed.bpm > MAX_BPM) {
      errors.push(`${name}: BPM ${parsed.bpm} is outside the SP-404SX range (${MIN_BPM}-${MAX_BPM}).`);
      continue;
    }
    if (byLabel.has(parsed.label)) {
      errors.push(`${name}: pad ${parsed.label} is already assigned to ${byLabel.get(parsed.label)}.`);
      continue;
    }
    byLabel.set(parsed.label, name);
    assignments.push({ ...parsed, file: path.resolve(folder, name), name });
  }
  const order = ({ label }) => (label.charCodeAt(0) - 65) * 12 + Number.parseInt(label.slice(1), 10);
  assignments.sort((a, b) => order(a) - order(b));
  return { assignments, skipped, errors };
}

/** Read the card's current pads, recovering any interrupted Super Pads save first. */
async function readCard(root) {
  const padInfo = path.join(root, SAMPLE_DIRECTORY, 'PAD_INFO.BIN');
  if (!fs.existsSync(padInfo)) {
    throw new Error(`No ${SAMPLE_DIRECTORY}/PAD_INFO.BIN under ${root}. Is this the SD card root, formatted by the sampler?`);
  }
  recoverCard(root);
  const pads = await decodePads(fs.readFileSync(padInfo));
  return Object.fromEntries(pads.map((pad) => [pad.label, { ...pad, convert: false, remove: false }]));
}

/** Queue every assignment as a Super Pads import and write the card. Returns the written pads by label. */
async function loadSamples({ root, assignments }) {
  const pads = await readCard(root);
  for (const { label, bpm, file } of assignments) {
    Object.assign(pads[label], PAD_SETTINGS, {
      convert: true, avaliable: false, remove: false, externalFile: file,
      originalTempo: bpm, userTempo: bpm,
    });
  }
  const state = { root, pads, padInfo: 'PAD_INFO.BIN', currentPad: 'A1', patterns: await readPatterns(root) };
  const { pads: written, warning } = await writeCard({ root, state });
  return { pads: Object.fromEntries(written.map((pad) => [pad.label, pad])), warning };
}

const USAGE = `Usage: sp404-load <samples-folder> <sd-card-root> [--dry-run]

Assigns files named <name>-<Bank><Pad>-<BPM>.<ext> (e.g. kick-A01-140.wav) to that pad,
converts them to 44.1 kHz 16-bit stereo WAV, and sets loop on, volume 127, Tempo Mode User,
and original/user BPM from the filename. Other pads on the card are left unchanged.

  --dry-run   Show the assignments without writing to the card.`;

async function main(argv) {
  const flags = argv.filter((arg) => arg.startsWith('-'));
  const args = argv.filter((arg) => !arg.startsWith('-'));
  if (flags.includes('-h') || flags.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const unknown = flags.filter((flag) => flag !== '--dry-run');
  if (unknown.length || args.length !== 2) {
    console.error(unknown.length ? `Unknown option: ${unknown.join(', ')}\n` : '');
    console.error(USAGE);
    return 2;
  }
  const [folder, root] = args.map((arg) => path.resolve(arg));
  const dryRun = flags.includes('--dry-run');

  const { assignments, skipped, errors } = planLoad(folder);
  for (const name of skipped) console.warn(`skip  ${name} (name does not match <name>-<Bank><Pad>-<BPM>.<ext>)`);
  if (errors.length) {
    for (const error of errors) console.error(`error ${error}`);
    console.error('\nNothing was written to the card.');
    return 1;
  }
  if (!assignments.length) {
    console.error('No matching samples found. Nothing was written to the card.');
    return 1;
  }
  for (const { label, bpm, name } of assignments) console.log(`${label.padEnd(4)} ${String(bpm).padStart(5)} BPM  ${name}`);
  if (dryRun) {
    console.log(`\nDry run: ${assignments.length} sample(s) would be written to ${root}.`);
    return 0;
  }

  console.log(`\nConverting and writing ${assignments.length} sample(s) to ${root}...`);
  const { pads, warning } = await loadSamples({ root, assignments });
  if (warning) console.warn(warning);
  const seconds = assignments.reduce((total, { label }) => total + pads[label].duration, 0);
  console.log(`Done. Wrote ${assignments.length} sample(s), ${seconds.toFixed(1)} s of audio.`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`error ${error.message}`);
    if (error.recoveryRequired) console.error('The card has a pending recovery; run again or open it in Super Pads to finish it.');
    else console.error('The card was left unchanged.');
    process.exitCode = 1;
  });
}

module.exports = { parseSampleName, planLoad, loadSamples, PAD_SETTINGS };
