// Suggested Instrument for a foreign MIDI track (ADR-0012). The current game's authored roster is
// the complete search space: unlisted registry folders are loadable by saved songs but are not
// choices this game offers, and roster order is the deliberate melody-first/SFX-last tie-break.
import { game } from '$game';
import { GENERAL_MIDI_FAMILY_ADJACENCY, isGeneralMidiTrackFamily } from './generalMidi';

/** The identity fields @tonejs/midi exposes; percussion patch names may be absent. */
export type MidiInstrumentIdentity = {
  name?: string;
  family?: string;
  /** GM program number (0-127). */
  number?: number;
  /** Channel 10 drum kit. */
  percussion?: boolean;
};

/**
 * Choose a current-game instrument without inspecting the track's notes. The game's own table
 * (game.json midi.instrumentSuggestions) answers first - the track's NAME, then the drum kit, then
 * the GM program range - because arrangers name tracks after the instrument they mean more reliably
 * than they set a program (most files never change it from 0, piano). Anything the table does not
 * answer falls back to the GM patch, then the exact/adjacent family, then the roster default.
 *
 * `trackName` is the name the FILE carries, never a synthesised fallback like "Track n.3".
 */
export function suggestMidiInstrument(identity: MidiInstrumentIdentity, trackName = ''): string {
  const roster = game.instruments.list;
  const definitions = game.instruments.data;
  const table = game.midi.instrumentSuggestions;

  const lowerName = trackName.toLowerCase();
  if (lowerName) {
    const hint = table.trackNames.find((entry) => lowerName.includes(entry.match));
    if (hint) return hint.instrument;
  }
  if (identity.percussion === true && table.drumKit !== null) return table.drumKit;
  if (identity.percussion !== true && typeof identity.number === 'number') {
    const range = table.programs.find(
      (entry) => identity.number! >= entry.from && identity.number! <= entry.to
    );
    if (range) return range.instrument;
  }
  const patchName = typeof identity.name === 'string' ? identity.name.toLowerCase() : null;

  if (patchName) {
    const patchMatch = roster.find(
      (instrumentName) => definitions[instrumentName]?.midiName.toLowerCase() === patchName
    );
    if (patchMatch) return patchMatch;
  }

  if (typeof identity.family === 'string') {
    const familyMatch = roster.find(
      (instrumentName) => definitions[instrumentName]?.family === identity.family
    );
    if (familyMatch) return familyMatch;
  }

  if (isGeneralMidiTrackFamily(identity.family)) {
    for (const family of GENERAL_MIDI_FAMILY_ADJACENCY[identity.family]) {
      const adjacentMatch = roster.find(
        (instrumentName) => definitions[instrumentName]?.family === family
      );
      if (adjacentMatch) return adjacentMatch;
    }
  }

  return roster[0];
}
