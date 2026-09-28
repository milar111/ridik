/**
 * The sweep has to recognise a kept recording on both platforms.
 *
 * The two do not agree on a name: Android writes `recording_<epoch ms>.wav`
 * and iOS writes `recording_<UUID>.wav`. A pattern that only allows digits is
 * right on one and matches *nothing* on the other — and a sweep that finds no
 * files is indistinguishable from a sweep with nothing to do, so the leak is
 * silent. That is exactly what this file exists to stop, and the reason it
 * reads the pattern out of the source rather than being handed it: the pattern
 * lives next to a `File` API that cannot load under plain Node.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function keptRecordingPattern(): RegExp {
  const source = readFileSync(join(__dirname, '..', 'record.ts'), 'utf8');
  const line = /const KEPT_RECORDING = \/(.+)\/;/.exec(source);
  if (!line) throw new Error('KEPT_RECORDING is not where this test expects it');
  return new RegExp(line[1]!);
}

const pattern = keptRecordingPattern();

describe('recognising a recording the recogniser kept', () => {
  it('matches Android, which names them by epoch milliseconds', () => {
    expect(pattern.test('recording_1789214131617.wav')).toBe(true);
  });

  it('matches iOS, which names them by UUID', () => {
    expect(pattern.test('recording_CD5E6C6C-3D9D-4754-9188-D6FAF97D9DF2.wav')).toBe(true);
    expect(pattern.test('recording_CD5E6C6C-3D9D-4754-9188-D6FAF97D9DF2.caf')).toBe(true);
  });

  /*
    The other half, and the more important one. This runs over the app's whole
    cache directory, which it shares with fonts, images and every library that
    keeps something there. It collects what this app asked to be written and
    nothing else.
  */
  it.each([
    'ExponentAsset-1363130c7bdf956d164cb7e605619849.ttf',
    'recording.wav',
    'my_recording_1.wav',
    'recording_1.mp3',
    'recording_1.wav.tmp',
    'recording_1.wav/../../secrets.db',
    'whisper-model.bin',
  ])('leaves %s alone', (name) => {
    expect(pattern.test(name)).toBe(false);
  });
});
