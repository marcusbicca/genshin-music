import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const midiParser = readFileSync(
  'src/lib/components/pages/Composer/MidiParser/MidiParser.svelte',
  'utf8'
);
const trackInfo = readFileSync(
  'src/lib/components/pages/Composer/MidiParser/TrackInfo.svelte',
  'utf8'
);
const statsTable = readFileSync(
  'src/lib/components/pages/Composer/MidiParser/MidiStatsTable.svelte',
  'utf8'
);
const english = readFileSync('src/lib/i18n/locales/en/index.ts', 'utf8');

describe('MIDI import panel policies', () => {
  it('keeps stranded notes off by default and exposes the switch beside accidentals', () => {
    expect(midiParser).toContain('let includeOutOfRange = $state(false);');
    expect(midiParser).toContain('includeOutOfRange,');
    const accidentalsSwitch = midiParser.indexOf('checked={includeAccidentals}');
    const strandedSwitch = midiParser.indexOf('checked={includeOutOfRange}');
    expect(accidentalsSwitch).toBeGreaterThan(-1);
    expect(strandedSwitch).toBeGreaterThan(accidentalsSwitch);
    expect(midiParser).toContain('include_out_of_range_notes_description');
  });

  it('shows the lock notice before import settings', () => {
    const notice = midiParser.indexOf('composer_locked_during_import');
    const settings = midiParser.indexOf('<fieldset');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(settings);
  });

  it('offers a per-track Basepoint override with the song-pitch fallback', () => {
    expect(trackInfo).toContain("t('common:pitch')");
    expect(trackInfo).toContain('selected={data.instrument.pitch as Pitch}');
    expect(trackInfo).toContain('<option value="">');
    expect(trackInfo).toContain("t('instrument_settings:use_song_pitch')");
    expect(trackInfo).toContain("data.instrument.clone().set({ pitch })");
  });

  it('suggests one offset from track-specific identities and Basepoints', () => {
    // mapped drum tracks are filtered out first: they ignore every offset
    expect(midiParser).toContain('.filter((track) => !isMappedPercussion(track))');
    expect(midiParser).toContain('.map((track) => ({');
    expect(midiParser).toContain('instrumentName: track.instrument.name');
    expect(midiParser).toContain('pitch: effectiveTrackPitch(track.instrument, pitch)');
    expect(midiParser).toContain('localOffset: track.localOffset');
    expect(midiParser).toContain('maxScaling: track.maxScaling');
    expect(midiParser).not.toContain('playableIdsOf');
  });
});

describe('MIDI import instrument swaps', () => {
  it('re-fits a track to the instrument it is swapped to', () => {
    // registers differ per instrument: the octave fitted for the old one strands the notes on the new
    const edit = midiParser.slice(midiParser.indexOf('function editTrack'));
    expect(edit).toContain('update.instrument.name !== previousInstrument');
    expect(edit.indexOf('fitTrack(track)')).toBeLessThan(edit.indexOf('convertMidi()'));
  });
});

describe('MIDI import panel accounting', () => {
  it('publishes totals before an all-dropped conversion refuses its preview', () => {
    const publish = midiParser.indexOf('totalNotes = result.totalNotes;');
    const emptyPreview = midiParser.indexOf('if (song.columns.length === 0)');
    expect(publish).toBeGreaterThan(-1);
    expect(publish).toBeLessThan(emptyPreview);
  });

  it('tracks the total separately from its directional split and clears every row first', () => {
    expect(midiParser).toContain('track.outOfRange = 0;');
    // a track's main and auxiliary layers all report into the same row, so the row sums them
    expect(midiParser).toContain('track.outOfRange += stats.outOfRange;');
    expect(trackInfo).toContain('outOfRange={data.outOfRange}');
    expect(trackInfo).not.toContain(
      'outOfRange={data.outOfRangeBounds.upper + data.outOfRangeBounds.lower}'
    );
  });

  it('uses a new English accidental heading and retires the misleading key', () => {
    expect(statsTable).toContain('of_which_are_accidentals');
    expect(statsTable).not.toContain('of_which_dont_fit');
    expect(english).toContain("of_which_are_accidentals: 'Of which are accidentals'");
    expect(english).not.toContain('of_which_dont_fit:');
  });
});
