const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadDataTools = require('super-pads/src/dataTools');
const ffmpeg = require('ffmpeg-static-electron').path;
const { parseSampleName, planLoad, loadSamples } = require('../sp404-load');

/** Create an empty card plus a samples folder; caller removes root. */
async function createCard() {
  const { SP404PadInfo } = await loadDataTools();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp404-load-'));
  const smpl = path.join(root, 'card', 'ROLAND', 'SP-404SX', 'SMPL');
  fs.mkdirSync(smpl, { recursive: true });
  fs.writeFileSync(path.join(smpl, 'PAD_INFO.BIN'), Buffer.concat(Array.from({ length: 120 }, () => SP404PadInfo.encodePad())));
  const samples = path.join(root, 'samples');
  fs.mkdirSync(samples);
  return { root, card: path.join(root, 'card'), smpl, samples };
}

/** Generate a short mono tone in any format FFmpeg can write (sample rate and codec chosen by extension/args). */
function tone(file, extra = []) {
  const result = spawnSync(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', ...extra, file]);
  assert.equal(result.status, 0, String(result.stderr));
}

test('parseSampleName reads bank, pad and BPM', () => {
  assert.deepEqual(parseSampleName('mysample-A01-140.wav'), { label: 'A1', bpm: 140 });
  assert.deepEqual(parseSampleName('my-loop-j12-92.5.aif'), { label: 'J12', bpm: 92.5 });
  assert.deepEqual(parseSampleName('x-C7-120.mp3'), { label: 'C7', bpm: 120 });
  assert.equal(parseSampleName('mysample.wav'), undefined);
  assert.equal(parseSampleName('bad-K01-120.wav'), undefined);
  assert.equal(parseSampleName('bad-A13-120.wav'), undefined);
  assert.equal(parseSampleName('bad-A00-120.wav'), undefined);
});

test('planLoad skips unmatched files and rejects duplicates and out-of-range BPM', async (t) => {
  const { root, samples } = await createCard();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['a-A01-120.wav', 'b-A1-90.wav', 'c-B02-300.wav', 'notes.txt', '._a-A03-120.wav']) {
    fs.writeFileSync(path.join(samples, name), '');
  }
  const { assignments, skipped, errors } = planLoad(samples);
  assert.deepEqual(assignments.map((a) => a.label), ['A1']);
  assert.deepEqual(skipped, ['notes.txt']);
  assert.equal(errors.length, 2);
});

test('loadSamples converts files and sets loop, volume, tempo mode and BPM', async (t) => {
  const { root, card, smpl, samples } = await createCard();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tone(path.join(samples, 'kick-A01-140.wav'), ['-ar', '48000', '-c:a', 'pcm_s24le']);
  tone(path.join(samples, 'loop-C12-92.5.aiff'));
  tone(path.join(samples, 'vox-J5-120.mp3'));
  const { assignments, errors } = planLoad(samples);
  assert.deepEqual(errors, []);
  await loadSamples({ root: card, assignments });

  const { SP404PadInfo, AudioWAV } = await loadDataTools();
  const { pads } = SP404PadInfo.fromFile(fs.readFileSync(path.join(smpl, 'PAD_INFO.BIN')));
  const byLabel = Object.fromEntries(pads.map((pad) => [pad.label, pad]));
  for (const [label, bpm] of [['A1', 140], ['C12', 92.5], ['J5', 120]]) {
    const pad = byLabel[label];
    assert.equal(pad.loop, true);
    assert.equal(pad.volume, 127);
    assert.equal(pad.tempoMode, 'User');
    assert.equal(pad.originalTempo, bpm);
    assert.equal(pad.userTempo, bpm);
    assert.equal(pad.channels, 'Stereo');
    const file = path.join(smpl, pad.filename);
    const { chunks } = AudioWAV.fromFile(fs.readFileSync(file), { strict: true });
    const format = chunks.find((chunk) => chunk.type === 'format').value;
    assert.equal(format.sampleRate, 44100);
    assert.equal(format.bitsPerSample, 16);
    assert.equal(format.channels, 2);
    assert.equal(pad.userSampleEnd, fs.statSync(file).size);
  }
  // Untouched pads keep their defaults.
  assert.equal(byLabel.B1.loop, false);
  assert.equal(fs.existsSync(path.join(smpl, 'B0000001.WAV')), false);
  assert.equal(fs.existsSync(path.join(card, '.super-pads-transaction')), false);
});

test('a failed conversion leaves the card unchanged', async (t) => {
  const { root, card, smpl, samples } = await createCard();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tone(path.join(samples, 'good-A01-120.wav'));
  fs.writeFileSync(path.join(samples, 'broken-A02-120.wav'), 'not audio');
  const before = fs.readFileSync(path.join(smpl, 'PAD_INFO.BIN'));
  await assert.rejects(loadSamples({ root: card, assignments: planLoad(samples).assignments }));
  assert.deepEqual(fs.readFileSync(path.join(smpl, 'PAD_INFO.BIN')), before);
  assert.equal(fs.existsSync(path.join(smpl, 'A0000001.WAV')), false);
});
