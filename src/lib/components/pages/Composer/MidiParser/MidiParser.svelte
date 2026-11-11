<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { base } from '$app/paths';
  import { BASE_LAYER_LIMIT } from '$core/sharedConfig';
  import type { Pitch } from '$lib/games/types';
  import { basicPitchLoader } from '$lib/audio/BasicPitchLoader';
  import { logger } from '$stores/LoggerStore.svelte';
  import { ThemeProvider } from '$core/theme/ThemeProvider.svelte';
  import { ComposedSong } from '$core/Songs/ComposedSong.svelte';
  import {
    importMidiTracks,
    midiNoteFitsLayer,
    midiNoteNumberOnLayer,
    finestColumnSeconds,
    midiNoteSurvivesOnLayer,
    suggestOffset,
    suggestTrackFit,
    type MidiImportTrack,
  } from '$core/Songs/midiImport';
  import {
    foldPhrases,
    hasPercussionMap,
    mapPercussionNotes,
    planTrackLayers,
    rangeExtensionsOf,
    foldPlannedLayers,
    type PlannedLayer,
  } from '$core/Songs/midiLayerPlan';
  import type { MissingKeyPolicy } from '$core/Songs/layerMerge';
  import {
    detectMidiSections,
    mergeSectionRange,
    type MidiSection,
  } from '$core/Songs/midiSections';
  import type { InstrumentData } from '$core/Songs/SongClasses';
  import { PITCHES } from '$core/sharedConfig';
  import { effectiveTrackPitch } from '$core/Songs/noteIds';
  import { decodeMidiMetadata, type MidiMetadata } from '$core/Songs/midiMetadata';
  import { delay, isAudioFormat, isVideoFormat } from '$core/utils/Utilities';
  import { t } from '$i18n/binding.svelte';
  import FilePicker, { type FileElement } from '$cmp/inputs/FilePicker.svelte';
  import Switch from '$cmp/inputs/Switch.svelte';
  import Select from '$cmp/inputs/Select.svelte';
  import PitchSelect from '$cmp/inputs/PitchSelect.svelte';
  import HelpTooltip from '$cmp/utility/HelpTooltip.svelte';
  import DecoratedCard from '$cmp/layout/DecoratedCard.svelte';
  import Row from '$cmp/layout/Row.svelte';
  import Column from '$cmp/layout/Column.svelte';
  import TrackInfo from './TrackInfo.svelte';
  import { buildMidiTrackRoster, type CustomTrack } from './midiTrackRoster';
  import { canonicalMidiPitch } from './midiPitch';
  import NumericalInput from './NumericalInput.svelte';
  import MidiStatsTable from './MidiStatsTable.svelte';
  // Midi/Track stay type-only imports (erased, so nothing to resolve at runtime); the two
  // `new Midi(...)` calls below take the constructor from $core/Songs/midiConstructor, which is
  // where the reason lives - no static import of '@tonejs/midi' as a value works in every runtime
  // this app is evaluated in, and the default import that used to be here is what broke MIDI
  // import for users in the built app.
  import type { Midi } from '@tonejs/midi';
  import { Midi as MidiConstructor } from '$core/Songs/midiConstructor';

  let {
    data,
    functions,
    initialFile = null,
  }: {
    data: {
      selectedColumn: number;
    };
    functions: {
      changeMidiVisibility: (override: boolean) => void;
      loadSong: (song: ComposedSong, options?: { preview?: boolean }) => void;
      /** Select a layer of the song in the composer (a track row was picked). */
      selectLayer?: (layer: number) => void;
    };
    /**
     * A file that already made the app open this screen (dropped on a menu that can't parse it):
     * parsed on mount so the user isn't asked to pick the same file twice. Read once at mount -
     * this component is mounted/unmounted with the modal, so "opened again" means a fresh mount.
     */
    initialFile?: File | null;
  } = $props();

  let fileName = $state('');
  let tracks: CustomTrack[] = $state([]);
  let bpm = $state(220);
  let offset = $state(0);
  let pitch: Pitch = $state('C');
  let accidentals = $state(0);
  let outOfRange = $state(0);
  //instrument config recovered from one of our own exports; null for any foreign file
  let importedMetadata: MidiMetadata | null = $state(null);
  let totalNotes = $state(0);
  //medley support: the import range. -1 = the whole file
  let sections: MidiSection[] = $state([]);
  let sectionIndex = $state(-1);
  //last section of the range (>= sectionIndex): joins sections the detection split apart
  let sectionEndIndex = $state(-1);
  const activeSection = $derived(
    sectionIndex < 0 ? undefined : mergeSectionRange(sections, sectionIndex, sectionEndIndex)
  );
  let fileKeyPitch: Pitch = 'C';
  let fileBpm = 220;
  let includeAccidentals = $state(true);
  let includeOutOfRange = $state(false);
  let keepAllDurations = $state(true);
  //notes a track's main layer cannot play go to extra layers (other scale / range extension)
  let auxiliaryLayers = $state(true);
  /** What a folded extra layer does with a note whose pitch class its destination lacks. */
  let fitPolicy = $state<MissingKeyPolicy>('keep');
  //out-of-range passages move by whole octaves as phrases, never note by note
  let phraseOctaves = $state(true);
  let warnedOfExperimental = false;
  // Parsing audio/video can outlive this import session by several seconds. A closed importer must
  // never install that stale result over the song after the lock has gone (or over a newer import).
  let componentAlive = true;
  // Every selected file owns one generation. Audio recognition is asynchronous and cannot be
  // cancelled inside Basic Pitch, so a newer selection revokes the older run's right to publish
  // progress, state, logger cleanup, or a preview.
  let fileRequestGeneration = 0;

  function claimFileRequest(): number {
    const generation = ++fileRequestGeneration;
    // A previous audio run may have left its spinner visible. The new owner either replaces it
    // with its own progress shortly or imports MIDI synchronously, in which case it should vanish.
    logger.hidePill();
    return generation;
  }

  function ownsFileRequest(generation: number): boolean {
    return componentAlive && generation === fileRequestGeneration;
  }

  onDestroy(() => {
    componentAlive = false;
    logger.hidePill();
  });

  const midiInputsStyle = $derived(
    `background-color:${ThemeProvider.layer('primary', 0.2).toString()};color:${ThemeProvider.getText('primary').toString()}`
  );

  async function handleFile(files: FileElement<File>[]) {
    if (files.length === 0) return;
    // FilePicker's `file` mode calls us at selection time. Reading the bytes here, after claiming
    // ownership, matters for two quickly selected files: a large older read may finish last.
    const generation = claimFileRequest();
    try {
      const pickedFile = files[0];
      const name = pickedFile.file.name;
      const data = await pickedFile.data.arrayBuffer();
      if (!ownsFileRequest(generation)) return;
      const file = { data, file: pickedFile.file };
      if (isVideoFormat(name)) {
        const audio = await extractAudio(file);
        if (!ownsFileRequest(generation)) return;
        return await parseAudioToMidi(audio, name, generation);
      } else if (isAudioFormat(name)) {
        const audio = await extractAudio(file);
        if (!ownsFileRequest(generation)) return;
        return await parseAudioToMidi(audio, name, generation);
      } else {
        const midi = new MidiConstructor(file.data);
        if (ownsFileRequest(generation)) return mandleMidiFile(midi, name, generation);
      }
    } catch (e) {
      if (!ownsFileRequest(generation)) return;
      console.error(e);
      logger.hidePill();
      logger.error(t('logs:error_opening_file'));
    }
  }

  // The handed-over file goes through handleFile untouched, i.e. the exact path a manual pick
  // takes. The handler owns the byte read as well as parsing, and the File name is what tells MIDI
  // from audio from video below (not the content).
  onMount(() => {
    const file = initialFile;
    if (!file) return;
    void handleFile([{ data: file, file }]);
  });

  async function extractAudio(audio: FileElement<ArrayBuffer>): Promise<AudioBuffer> {
    const ctx = new AudioContext({
      sampleRate: 22050,
    });
    const buffer = (await new Promise((res, rej) => {
      ctx!.decodeAudioData(audio.data as ArrayBuffer, res, rej);
    })) as AudioBuffer;
    ctx.close();
    return buffer;
  }

  async function parseAudioToMidi(audio: AudioBuffer, name: string, generation: number) {
    if (!ownsFileRequest(generation)) return;
    if (!warnedOfExperimental) logger.warn(t('composer:midi_parser.audio_conversion_warning'));
    warnedOfExperimental = true;
    const frames: number[][] = [];
    const onsets: number[][] = [];
    const model = `${base}/assets/audio-midi-model.json`;
    logger.showPill(`${t('composer:midi_parser.detecting_notes')}...`, { spinner: true });
    const { BasicPitch, noteFramesToTime, outputToNotesPoly } = await basicPitchLoader();
    if (!ownsFileRequest(generation)) return;
    const basicPitch = new BasicPitch(model);
    const mono = audio.getChannelData(0);
    await basicPitch.evaluateModel(
      mono,
      (f, o) => {
        if (!ownsFileRequest(generation)) return;
        frames.push(...f);
        onsets.push(...o);
      },
      (progress) => {
        if (!ownsFileRequest(generation)) return;
        logger.showPill(
          `${t('composer:midi_parser.detecting_notes')}: ${Math.floor(progress * 100)}%...`,
          { spinner: true }
        );
      }
    );
    if (!ownsFileRequest(generation)) return;
    logger.showPill(t('composer:midi_parser.converting_audio_to_midi'), { spinner: true });
    await delay(300);
    if (!ownsFileRequest(generation)) return;
    const notes = noteFramesToTime(
      outputToNotesPoly(
        frames, //frames
        onsets, //onsets
        0.5, //onsetThreshold
        0.3, //frameThreshold
        11, //minimumDuration
        true, //inferOnsets
        3000, //maxHz
        0, //minHz
        true //smooth
      )
    );
    const midi = new MidiConstructor();
    const track = midi.addTrack();
    notes.forEach((note) => {
      track.addNote({
        midi: note.pitchMidi,
        time: note.startTimeSeconds,
        duration: note.durationSeconds,
        velocity: note.amplitude,
      });
    });
    if (!ownsFileRequest(generation)) return;
    logger.hidePill();
    mandleMidiFile(midi, name, generation);
  }

  /** The notes of a track inside the selected section, re-timed so the section starts at 0. */
  function trackNotes(track: CustomTrack): { midi: number; time: number; duration: number }[] {
    const section = activeSection;
    if (!section) return track.track.notes;
    return track.track.notes
      .filter((note) => note.time >= section.start - 1e-3 && note.time < section.end - 1e-3)
      .map((note) => ({
        midi: note.midi,
        time: note.time - section.start,
        duration: Math.min(note.duration, section.end - note.time),
      }));
  }

  function sectionPitch(section: MidiSection): Pitch | undefined {
    const tonic = canonicalMidiPitch(section.key ?? undefined);
    if (tonic === undefined) return undefined;
    //a minor key signature names the minor tonic; the Basepoint is a major-scale root
    return section.minor ? PITCHES[(PITCHES.indexOf(tonic) + 3) % 12] : tonic;
  }

  function formatTime(seconds: number) {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /**
   * Give every track its own Basepoint and octave (suggestTrackFit): each layer has its own 15
   * buttons, so the best scale/octave for the melody is rarely the best one for the bass.
   */
  /**
   * Fit ONE track to its current instrument: the layer scale and whole-octave offset that put the
   * most notes on that instrument's buttons. Returns null for a track with nothing to fit.
   */
  function fitTrack(track: CustomTrack) {
    const notes = trackNotes(track);
    if (notes.length === 0) return null;
    //a mapped drum track is placed key by key; there is no scale or octave to fit
    if (isMappedPercussion(track)) return null;
    const fit = suggestTrackFit(notes, track.instrument.name, pitch, track.maxScaling, PITCHES);
    track.instrument = track.instrument
      .clone()
      .set({ pitch: fit.pitch === pitch ? '' : fit.pitch });
    track.localOffset = fit.localOffset;
    return fit;
  }

  function autoFitTracks(announce = true) {
    let stranded = 0;
    let accidentalCount = 0;
    for (const track of tracks) {
      const fit = fitTrack(track);
      if (!fit) continue;
      if (track.selected) {
        stranded += fit.stranded;
        accidentalCount += fit.accidentals;
      }
    }
    if (tracks.length > 0) convertMidi();
    if (announce) {
      logger.success(
        t('composer:midi_parser.auto_fit_done', {
          accidentals: `${accidentalCount}`,
          stranded: `${stranded}`,
        })
      );
    }
  }

  /** Select the tracks that play inside the current range (most notes first, up to the layer limit). */
  function selectTracksInSection() {
    const counts = tracks.map((track) => trackNotes(track).length);
    const order = tracks
      .map((_, i) => i)
      .filter((i) => counts[i] > 0)
      .sort((a, b) => counts[b] - counts[a])
      .slice(0, BASE_LAYER_LIMIT);
    tracks.forEach((track, i) => (track.selected = order.includes(i)));
  }

  /** A drum track whose instrument can take the kit key by key (meta.json percussionMap). */
  function isMappedPercussion(track: CustomTrack) {
    return track.percussion && hasPercussionMap(track.instrument.name);
  }

  function changeSectionEnd(value: number) {
    sectionEndIndex = Math.max(value, sectionIndex);
    if (tracks.length === 0) return;
    selectTracksInSection();
    if (importedMetadata) convertMidi();
    else autoFitTracks(false);
  }

  function changeSection(value: number) {
    sectionIndex = value;
    sectionEndIndex = value;
    const section = sections[value];
    if (section) {
      bpm = Math.round(section.bpm * 4) || bpm;
      pitch = sectionPitch(section) ?? pitch;
    } else {
      bpm = fileBpm;
      pitch = fileKeyPitch;
    }
    if (tracks.length === 0) return;
    selectTracksInSection();
    if (importedMetadata) convertMidi();
    else autoFitTracks(false);
  }

  // QUIRK: mandleMidiFile (not handleMidiFile) is an intentional preserved typo.
  function mandleMidiFile(midi: Midi, name: string, generation: number) {
    if (!ownsFileRequest(generation)) return;
    try {
      const midiBpm = midi.header.tempos[0]?.bpm;
      const key = midi.header.keySignatures[0]?.key;
      //Only the instrument configuration comes from metadata, and only when the file is one of
      //ours. Everything musical below — tempo, placement, note lengths — is still read off the
      //MIDI itself, so importing our own export exercises the same code a foreign file does.
      importedMetadata = decodeMidiMetadata(midi.header.meta ?? []);
      tracks = buildMidiTrackRoster(midi.tracks, importedMetadata?.instruments ?? null);
      fileName = name;
      sectionIndex = -1;
      sectionEndIndex = -1;
      //our own exports already carry their layers; a foreign file gets the arranging helpers
      auxiliaryLayers = !importedMetadata;
      phraseOctaves = !importedMetadata;
      sections = importedMetadata ? [] : detectMidiSections(midi.header, midi.duration);
      //round, not floor: this is the inverse of toMidi's setTempo(bpm / 4), and the tempo
      //survives serialization as an integer microseconds-per-quarter, so the value coming
      //back can sit a hair under the original and lose a whole bpm to truncation
      bpm = Math.round(midiBpm * 4) || 220;
      offset = 0;
      //`pitch` is the Basepoint the imported song will carry, so it rides in the metadata
      //alongside the rest of the instrument config. The key signature is still preferred when a
      //foreign file supplies one. Since ADR-0007 it also decides what the emitted notes ARE (the
      //snapped nominals are lifted by it), which is why convertMidi below is re-run on any change.
      pitch = canonicalMidiPitch(key) ?? importedMetadata?.pitch ?? 'C';
      fileKeyPitch = pitch;
      fileBpm = bpm;
      //a file whose every track was filtered out above has nothing to convert, and both the track
      //list and the summary table are gated on `tracks.length` - without this the screen would
      //show the filename and then say nothing at all, which reads as a broken importer
      if (tracks.length === 0) return logger.warn(t('composer:midi_parser.there_are_no_notes'));
      if (tracks.length > BASE_LAYER_LIMIT) warnTrackLimit();
      //a foreign file gets every track fitted to its own instrument right away (scale + octave);
      //our own exports already carry the layer setup they were made with
      if (importedMetadata) convertMidi();
      else autoFitTracks(false);
    } catch (e) {
      console.error(e);
      logger.error(t('composer:midi_parser.error_is_file_midi'));
    }
  }

  function convertMidi() {
    const selectedTracks = tracks.filter((track) => track.selected);
    for (const track of tracks) {
      track.numberOfAccidentals = 0;
      track.extraLayers = 0;
      track.plannedLayers = [];
      track.unmappedHits = 0;
      track.outOfRange = 0;
      track.outOfRangeBounds.lower = 0;
      track.outOfRangeBounds.upper = 0;
    }
    if (selectedTracks.length === 0) {
      accidentals = 0;
      totalNotes = 0;
      outOfRange = 0;
      return logger.warn(t('composer:midi_parser.there_are_no_notes'));
    }

    // The selected set IS the generated roster, in file order: each track's main layer, followed
    // by the auxiliary layers planned for it. No state from the open composer participates.
    const { importTracks, layers, owners } = planLayers(selectedTracks);
    const result = importMidiTracks(importTracks, {
      bpm,
      offset,
      includeAccidentals,
      includeOutOfRange,
      keepAllDurations,
      //the Basepoint the song below is given: the importer takes it off every incoming number
      //and puts it back on every emitted one (ADR-0007), so the two must be the same value
      pitch,
      //the layers themselves, not a capability flag derived from them: the importer needs each
      //layer's instrument to know what a snapped nominal sounds there, and reads the sustain
      //capability off the same config — nothing here knows which game is loaded
      layers,
    });
    result.perTrack.forEach((stats, index) => {
      const track = owners[index];
      track.numberOfAccidentals += stats.accidentals;
      track.outOfRange += stats.outOfRange;
      track.outOfRangeBounds.lower += stats.outOfRangeLower;
      track.outOfRangeBounds.upper += stats.outOfRangeUpper;
    });
    // Publish the accounting before considering whether a preview can be installed. A conversion
    // whose policies exclude every note still has useful costs to show in the panel, and leaving
    // the previous file's totals behind makes those controls impossible to reason about.
    accidentals = result.accidentals;
    totalNotes = result.totalNotes;
    outOfRange = result.outOfRange;
    const columns = result.columns;
    const song = new ComposedSong('Untitled');
    //initColumnsForConstruction, not a mutator: this song is being BUILT here and is handed to loadSong below,
    //so nothing is subscribed to it yet and there is no version to bump
    song.initColumnsForConstruction(columns);
    //enforce the no-overlap Duration invariant over the imported spans
    song.normalizeSpans();
    song.bpm = bpm;
    song.instruments = layers.map((instrument) => instrument.clone());
    song.pitch = pitch;
    if (importedMetadata) song.reverb = importedMetadata.reverb;
    const lastColumn = data.selectedColumn;
    song.selected = lastColumn < song.columns.length ? lastColumn : 0;
    if (song.columns.length === 0) {
      return logger.warn(t('composer:midi_parser.there_are_no_notes'));
    }
    if (!componentAlive) return;
    functions.loadSong(song, { preview: true });
  }

  /**
   * Turn the selected tracks into import layers (midiLayerPlan.ts): a mapped drum track becomes one
   * layer of button hits; any other track may have its phrases moved by octaves, and its leftover
   * notes spread over auxiliary layers - within the song's layer limit, which every track's main
   * layer is guaranteed first.
   */
  function planLayers(selectedTracks: CustomTrack[]) {
    const importTracks: MidiImportTrack[] = [];
    const layers: InstrumentData[] = [];
    const owners: CustomTrack[] = [];
    //the importer's bpm counts columns: four of them make a quarter note
    const quarterSeconds = bpm > 0 ? 240 / bpm : 1;
    let budget = BASE_LAYER_LIMIT - selectedTracks.length;
    const nextMainLayerOf = new Map<number, number>();
    const add = (
      track: CustomTrack,
      instrument: InstrumentData,
      entry: Omit<MidiImportTrack, 'layer'>
    ) => {
      if (!owners.includes(track)) nextMainLayerOf.set(track.originalIndex, layers.length);
      importTracks.push({ ...entry, layer: layers.length });
      layers.push(instrument);
      owners.push(track);
    };
    for (const track of selectedTracks) {
      const name = track.instrument.name;
      const mainPitch = effectiveTrackPitch(track.instrument, pitch);
      let notes = trackNotes(track);
      if (isMappedPercussion(track)) {
        const mapped = mapPercussionNotes(notes, name, mainPitch, quarterSeconds / 2);
        track.unmappedHits = mapped.unmapped;
        add(track, track.instrument, {
          notes: mapped.notes,
          localOffset: 0,
          maxScaling: 0,
          direct: true,
        });
        continue;
      }
      const localOffset = track.localOffset ?? offset;
      const extensions = auxiliaryLayers ? rangeExtensionsOf(name) : [];
      if (phraseOctaves) {
        notes = foldPhrases(notes, {
          instruments: [name, ...extensions],
          pitch: mainPitch,
          localOffset,
          phraseGapSeconds: quarterSeconds,
          maxOctaves: 2,
        }).notes;
      }
      const entry = { localOffset: track.localOffset, maxScaling: track.maxScaling };
      if (!auxiliaryLayers || budget <= 0) {
        add(track, track.instrument, { ...entry, notes });
        continue;
      }
      const plan = planTrackLayers(notes, {
        instrumentName: name,
        pitch: mainPitch,
        localOffset,
        pitches: PITCHES,
        extensions,
        maxAuxiliaryLayers: budget,
      });
      const kept = foldTrackLayers(track, plan, localOffset);
      for (const planned of kept) {
        add(
          track,
          planned.role === 'main'
            ? track.instrument
            : auxiliaryInstrument(track, planned.instrumentName, planned.pitch, mainPitch),
          {
            ...entry,
            notes: planned.notes,
          }
        );
      }
      track.extraLayers = kept.length - 1;
      budget -= track.extraLayers;
    }
    mainLayerOf = nextMainLayerOf;
    return { importTracks, layers, owners };
  }

  /** What a planned layer can play: the MIDI numbers that land on one of its keys. */
  function playableMidi(instrumentName: string, layerPitch: Pitch, localOffset: number) {
    const keys: number[] = [];
    for (let midi = 0; midi <= 127; midi++) {
      if (midiNoteFitsLayer(midi, instrumentName, layerPitch, localOffset)) keys.push(midi);
    }
    return keys;
  }

  /**
   * THE USER'S FOLDS of a track's extra layers (track.layerMerges, see midiLayerPlan's
   * foldPlannedLayers), and the list the track row shows them in (track.plannedLayers).
   */
  function foldTrackLayers(
    track: CustomTrack,
    plan: PlannedLayer[],
    localOffset: number
  ): PlannedLayer[] {
    const folded = foldPlannedLayers(plan, track.layerMerges, {
      keysOf: (layer) => playableMidi(layer.instrumentName, layer.pitch, localOffset),
      numberOf: (layer, midi) => midiNoteNumberOnLayer(midi, layer.instrumentName, layer.pitch, localOffset),
      sameMomentSeconds: finestColumnSeconds(bpm),
      survives: (layer, midi) => midiNoteSurvivesOnLayer(midi, layer.instrumentName, layer.pitch, localOffset),
      policy: fitPolicy,
    });
    track.plannedLayers = folded.listing;
    return folded.layers;
  }

  /** The track's layer settings on another scale and/or a range-extension instrument. */
  function auxiliaryInstrument(
    track: CustomTrack,
    name: string,
    layerPitch: Pitch,
    mainPitch: Pitch
  ) {
    const base =
      name === track.instrument.name
        ? track.instrument.clone()
        : track.instrument.withInstrument(name);
    const label = track.instrument.alias || track.name;
    //an auto-named track's extra layers are auto-named too: layerNames.ts numbers a layer that
    //follows its track at another scale as part of it ("Violin 2", "Violin 2 (Eb)")
    if (track.instrument.autoName) {
      return base.set({
        pitch:
          layerPitch === mainPitch
            ? track.instrument.pitch
            : layerPitch === pitch
              ? ''
              : layerPitch,
        alias: '',
        autoName: true,
        extensionLayer: true,
      });
    }
    return base.set({
      //same scale as the main layer: follow whatever the main layer follows (the song's or its own)
      pitch:
        layerPitch === mainPitch ? track.instrument.pitch : layerPitch === pitch ? '' : layerPitch,
      alias: `${label} (${name === track.instrument.name ? layerPitch : name})`,
      extensionLayer: true,
    });
  }

  function toggleAuxiliaryLayers() {
    auxiliaryLayers = !auxiliaryLayers;
    if (tracks.length > 0) convertMidi();
  }

  function togglePhraseOctaves() {
    phraseOctaves = !phraseOctaves;
    if (tracks.length > 0) convertMidi();
  }

  function warnTrackLimit() {
    logger.warn(
      t('composer:cant_add_more_than_n_layers', {
        max_layers: BASE_LAYER_LIMIT,
      })
    );
  }

  function editTrack(index: number, update: Partial<CustomTrack>) {
    if (applyTrackUpdate(index, update) && tracks.length > 0) convertMidi();
  }

  /** One field update on one track, without converting; false when it was refused. */
  function applyTrackUpdate(index: number, update: Partial<CustomTrack>): boolean {
    const track = tracks[index];
    if (!track) return false;
    if (
      update.selected === true &&
      !track.selected &&
      tracks.filter((candidate) => candidate.selected).length >= BASE_LAYER_LIMIT
    ) {
      warnTrackLimit();
      return false;
    }
    const previousInstrument = track.instrument.name;
    Object.assign(track, update);
    //Instruments sit in different registers (Violin C4-C6, Cello C2-C4, WinterPiano C5-C7...), so
    //the octave fitted for the old one strands most notes on the new one - they would silently
    //vanish as out of range. A swap therefore re-fits the track to the instrument it now has.
    if (update.instrument && update.instrument.name !== previousInstrument) fitTrack(track);
    return true;
  }

  /**
   * WHICH TRACKS AN INSTRUMENT OR VOLUME EDIT REACHES (the row's "Apply to"), like the composer
   * layer panel's scope: this track, or every track playing the same instrument right now.
   */
  let trackScope = $state<'track' | 'instrument'>('track');

  /** One edit over the tracks in scope of `index`, converted ONCE. */
  function editTracksInScope(index: number, change: (track: CustomTrack) => Partial<CustomTrack>) {
    const source = tracks[index];
    if (!source) return;
    const indices =
      trackScope === 'track'
        ? [index]
        : tracks
            .map((track, i) => (track.instrument.name === source.instrument.name ? i : -1))
            .filter((i) => i !== -1);
    let changed = false;
    for (const i of indices) changed = applyTrackUpdate(i, change(tracks[i])) || changed;
    if (changed && tracks.length > 0) convertMidi();
  }

  /** The composer layer each track's main layer became in the last conversion, by file index. */
  let mainLayerOf = new Map<number, number>();
  let focusedTrack = $state(-1);

  /** A track row was picked: select its main layer in the composer behind the importer. */
  function focusTrack(index: number) {
    focusedTrack = index;
    const layer = mainLayerOf.get(tracks[index]?.originalIndex ?? -1);
    if (layer !== undefined) functions.selectLayer?.(layer);
  }

  function suggestGlobalOffset() {
    const selected = tracks.filter((track) => track.selected);
    if (selected.length === 0) {
      //reachable with every track deselected, and a button that does nothing at all reads as
      //broken rather than as "nothing to work on"
      return logger.warn(t('composer:midi_parser.there_are_no_notes'));
    }
    const suggestion = suggestOffset(
      //mapped drum tracks ignore every offset, so they must not sway the choice
      selected
        .filter((track) => !isMappedPercussion(track))
        .map((track) => ({
          notes: trackNotes(track),
          instrumentName: track.instrument.name,
          pitch: effectiveTrackPitch(track.instrument, pitch),
          localOffset: track.localOffset,
          maxScaling: track.maxScaling,
        }))
    );
    changeOffset(suggestion.offset);
    logger.success(
      t('composer:midi_parser.suggested_offset', {
        offset: `${suggestion.offset}`,
        accidentals: `${suggestion.accidentals}`,
        stranded: `${suggestion.stranded}`,
      })
    );
  }

  function changeOffset(value: number) {
    if (!Number.isInteger(value)) value = 0;
    if (offset === value) return;
    offset = value;
    if (tracks.length > 0) convertMidi();
  }

  function changePitch(value: Pitch) {
    pitch = value;
    //the Basepoint is an input to the CONVERSION now, not just a playback label the composer
    //keeps beside it: re-run so the preview the user is looking at is the song they would load
    if (tracks.length > 0) convertMidi();
  }

  function toggleAccidentals() {
    includeAccidentals = !includeAccidentals;
    if (tracks.length > 0) convertMidi();
  }

  function toggleKeepDurations() {
    keepAllDurations = !keepAllDurations;
    if (tracks.length > 0) convertMidi();
  }

  function toggleOutOfRange() {
    includeOutOfRange = !includeOutOfRange;
    if (tracks.length > 0) convertMidi();
  }

  function changeBpm(value: number) {
    if (!Number.isInteger(value)) value = 0;
    if (bpm === value) return;
    bpm = value;
    if (tracks.length > 0) convertMidi();
  }
</script>

<DecoratedCard class="floating-midi" size="1.2rem" isRelative={false} offset="0.1rem">
  <Column class="floating-midi-content" gap="0.3rem">
    <Row align="center" style="width:100%">
      <FilePicker onPick={handleFile} as="file">
        <button class="midi-btn" style="{midiInputsStyle};white-space:nowrap">
          {t('composer:midi_parser.open_midi_audio_file')}
        </button>
      </FilePicker>
      <div style="margin:0 0.5rem;{fileName ? '' : 'opacity:0.6'}" class="text-ellipsis">
        {fileName || t('composer:midi_parser.no_file_selected')}
      </div>
      <button
        class="midi-btn"
        style="margin-left:auto;{midiInputsStyle}"
        onclick={() => functions.changeMidiVisibility(false)}
      >
        {t('common:close')}
      </button>
    </Row>

    <div class="midi-lock-notice">
      {t('composer:midi_parser.composer_locked_during_import')}
    </div>

    <fieldset class={['midi-section', tracks.length === 0 && 'midi-section-disabled']}>
      <legend>{t('composer:midi_parser.import_settings')}</legend>
      <Column gap="0.3rem" style="width:100%">
        {#if sections.length > 1}
          <Row justify="between" align="center">
            <div class="row flex-centered" style="gap:0.5rem">
              <span>{t('composer:midi_parser.section')}:</span>
              <HelpTooltip buttonStyle="width:1.2rem;height:1.2rem">
                {t('composer:midi_parser.section_description')}
              </HelpTooltip>
            </div>
            <select
              class="midi-section-select"
              style={midiInputsStyle}
              value={sectionIndex}
              onchange={(event) => changeSection(Number(event.currentTarget.value))}
            >
              <option value={-1}>{t('composer:midi_parser.whole_file')}</option>
              {#each sections as section, i (i)}
                <option value={i}>
                  {`${i + 1}. ${formatTime(section.start)}–${formatTime(section.end)} · ${section.key ?? '?'}${section.minor ? 'm' : ''} · ${Math.round(section.bpm)} bpm`}
                </option>
              {/each}
            </select>
          </Row>
          {#if sectionIndex >= 0 && sectionIndex < sections.length - 1}
            <Row justify="between" align="center">
              <div class="row flex-centered" style="gap:0.5rem">
                <span>{t('composer:midi_parser.section_until')}:</span>
                <HelpTooltip buttonStyle="width:1.2rem;height:1.2rem">
                  {t('composer:midi_parser.section_until_description')}
                </HelpTooltip>
              </div>
              <select
                class="midi-section-select"
                style={midiInputsStyle}
                value={sectionEndIndex}
                onchange={(event) => changeSectionEnd(Number(event.currentTarget.value))}
              >
                {#each sections as section, i (i)}
                  {#if i >= sectionIndex}
                    <option value={i}>
                      {`${i + 1}. ${formatTime(section.end)}`}
                    </option>
                  {/if}
                {/each}
              </select>
            </Row>
          {/if}
        {/if}
        <Row justify="between" align="center">
          <div class="row flex-centered" style="gap:0.5rem">
            <span>{t('composer:midi_parser.auto_fit_tracks')}:</span>
            <HelpTooltip buttonStyle="width:1.2rem;height:1.2rem">
              {t('composer:midi_parser.auto_fit_tracks_description')}
            </HelpTooltip>
          </div>
          <button
            class="midi-suggest-button"
            disabled={tracks.length === 0}
            onclick={() => autoFitTracks()}
          >
            {t('composer:midi_parser.auto_fit')}
          </button>
        </Row>
        <Row justify="between" align="center">
          <div style="margin-right:0.5rem">{t('composer:midi_parser.tempo_bpm')}:</div>
          <NumericalInput value={bpm} onChange={changeBpm} delay={600} step={5} />
        </Row>
        <Row justify="between" align="center">
          <div class="row flex-centered">
            <span style="margin-right:0.5rem"
              >{t('composer:midi_parser.global_note_offset')}:
            </span>
            <HelpTooltip buttonStyle="width:1.2rem;height:1.2rem">
              {t('composer:midi_parser.global_note_offset_description')}
            </HelpTooltip>
          </div>
          <Row align="center" style="gap:0.4rem">
            <button
              class="midi-suggest-button"
              disabled={tracks.length === 0}
              onclick={suggestGlobalOffset}
            >
              {t('composer:midi_parser.suggest_offset')}
            </button>
            <NumericalInput value={offset} onChange={changeOffset} delay={600} step={1} />
          </Row>
        </Row>
        <Row justify="between" align="center">
          <div style="margin-right:0.5rem">{t('composer:midi_parser.base_pitch')}:</div>
          <PitchSelect
            style="width:5rem;{midiInputsStyle}"
            selected={pitch}
            onChange={changePitch}
          />
        </Row>
        <Row gap="1rem" align="center" justify="between" style="width:100%">
          <Row justify="between" align="center" gap="1rem">
            <div>{t('composer:midi_parser.include_accidentals')}:</div>
            <Switch
              checked={includeAccidentals}
              onchange={toggleAccidentals}
              styleOuter={midiInputsStyle}
            />
          </Row>
          <Row justify="between" align="center" gap="1rem">
            <div class="row flex-centered" style="gap: 0.5rem">
              <span>{t('composer:midi_parser.include_out_of_range_notes')}:</span>
              <HelpTooltip position="left" buttonStyle="width:1.2rem;height:1.2rem">
                {t('composer:midi_parser.include_out_of_range_notes_description')}
              </HelpTooltip>
            </div>
            <Switch
              checked={includeOutOfRange}
              onchange={toggleOutOfRange}
              styleOuter={midiInputsStyle}
            />
          </Row>
        </Row>
        <Row justify="between" align="center">
          <div class="row flex-centered" style="gap: 0.5rem">
            <span>{t('composer:midi_parser.keep_all_durations')}:</span>
            <HelpTooltip position="left" buttonStyle="width:1.2rem;height:1.2rem">
              {t('composer:midi_parser.keep_all_durations_description')}
            </HelpTooltip>
          </div>
          <Switch
            checked={keepAllDurations}
            onchange={toggleKeepDurations}
            styleOuter={midiInputsStyle}
          />
        </Row>
        <Row justify="between" align="center">
          <div class="row flex-centered" style="gap: 0.5rem">
            <span>{t('composer:midi_parser.auxiliary_layers')}:</span>
            <HelpTooltip position="left" buttonStyle="width:1.2rem;height:1.2rem">
              {t('composer:midi_parser.auxiliary_layers_description')}
            </HelpTooltip>
          </div>
          <Switch
            checked={auxiliaryLayers}
            onchange={toggleAuxiliaryLayers}
            styleOuter={midiInputsStyle}
          />
        </Row>
        {#if auxiliaryLayers}
          <Row justify="between" align="center">
            <div class="row flex-centered" style="gap: 0.5rem">
              <span>{t('composer:midi_parser.fold_missing')}:</span>
              <HelpTooltip position="left" buttonStyle="width:1.2rem;height:1.2rem">
                {t('composer:midi_parser.fold_missing_description')}
              </HelpTooltip>
            </div>
            <Select
              style={midiInputsStyle}
              value={fitPolicy}
              onchange={(e) => {
                fitPolicy = e.currentTarget.value as MissingKeyPolicy;
                if (tracks.length > 0) convertMidi();
              }}
            >
              <option value="keep">{t('instrument_settings:fit_missing_keep')}</option>
              <option value="nearest">{t('instrument_settings:fit_missing_nearest')}</option>
              <option value="drop">{t('instrument_settings:fit_missing_drop')}</option>
            </Select>
          </Row>
        {/if}
        <Row justify="between" align="center">
          <div class="row flex-centered" style="gap: 0.5rem">
            <span>{t('composer:midi_parser.phrase_octaves')}:</span>
            <HelpTooltip position="left" buttonStyle="width:1.2rem;height:1.2rem">
              {t('composer:midi_parser.phrase_octaves_description')}
            </HelpTooltip>
          </div>
          <Switch
            checked={phraseOctaves}
            onchange={togglePhraseOctaves}
            styleOuter={midiInputsStyle}
          />
        </Row>
      </Column>
    </fieldset>
    {#if tracks.length > 0}
      <fieldset class="midi-section">
        <legend>{t('composer:midi_parser.track_settings')}</legend>
        <Column style="width:100%">
          {#each tracks as track, i (i)}
            <TrackInfo
              data={track}
              index={i}
              songPitch={pitch}
              onChange={editTrack}
              scope={trackScope}
              onScopeChange={(scope) => (trackScope = scope)}
              onChangeInScope={editTracksInScope}
              focused={focusedTrack === i}
              onFocus={focusTrack}
            />
          {/each}
        </Column>
      </fieldset>
      <MidiStatsTable notes={totalNotes} {accidentals} {outOfRange} />
    {/if}
  </Column>
</DecoratedCard>

<style>
  /* A real fieldset/legend: the browser breaks the border under the title on its own, which no
     background-matched overlay can do over this card - it is translucent (.floating-midi). */
  .midi-section {
    width: 100%;
    margin: 0;
    padding: 0.2rem 0.6rem 0.5rem;
    border: solid 0.1rem var(--secondary);
    border-radius: 0.3rem;
    min-inline-size: min-content;
  }

  .midi-section legend {
    padding: 0 0.3rem;
    font-weight: bold;
  }

  .midi-lock-notice {
    opacity: 0.85;
    text-align: center;
  }

  /* No file yet: the settings are inert, and they LOOK it. The cursor lives on the fieldset -
     which keeps its pointer events - because a pointer-events:none element shows no cursor at
     all; only the content below it is made unreachable. */
  .midi-section-disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .midi-section-disabled > :global(*) {
    pointer-events: none;
  }

  .midi-suggest-button {
    background-color: var(--primary);
    color: var(--primary-text);
    border: none;
    border-radius: 0.3rem;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .midi-section-select {
    border: none;
    border-radius: 0.3rem;
    padding: 0.3rem 0.4rem;
    max-width: 60%;
  }
  .midi-suggest-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* :global() below: `floating-midi` is handed to DecoratedCard as a class prop, so it lands on
     that component's root div - not on an element in this file's own template. */
  :global(.floating-midi) {
    position: absolute;
    margin-left: auto;
    margin-right: auto;
    bottom: 2rem;
    /* FIXED size, not bounds: sized to its content, the card grew the moment a file was opened
       (track list + summary appearing), shifting everything in it under the pointer. The mobile
       override below was already fixed for the same reason. */
    height: 48vh;
    border-radius: 0.5rem;
    background-color: rgba(var(--menu-background-rgb), 0.9);
    border: solid 2px var(--secondary);
    color: var(--menu-background-text);
    width: 60vw;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    --backdrop-amount: 4px;
    /* fadeIn/delayBackdrop are global keyframes from Utility.scss. Svelte only rewrites animation
       names it also finds in @keyframes of THIS file, so declaring either name here would silently
       rebind these two to the local copy. */
    animation:
      fadeIn 0.4s,
      delayBackdrop calc(0.4s * 1.2) forwards;
  }

  /* Same reason as above: this one is handed to Column as a class prop. */
  :global(.floating-midi-content) {
    padding: 0.8rem;
    padding-right: 0.5rem;
    width: 100%;
    height: 100%;
    overflow-y: scroll;
  }

  /* :global() because the wildcard reaches every child component rendered inside the card. */
  :global(.floating-midi *) {
    font-size: 0.9rem;
  }

  .midi-btn {
    background-color: var(--primary);
    color: white;
    border-radius: 0.2rem;
    padding: 0.5rem 1rem;
    border: none;
    height: -moz-fit-content;
    height: fit-content;
    cursor: pointer;
    min-width: 5rem;
  }

  @media only screen and (max-width: 1000px) {
    :global(.floating-midi) {
      bottom: 0.8rem;
      height: 50vh;
      max-height: 50vh;
      max-width: 70vw;
      width: 70vw;
    }

    :global(.floating-midi-content) {
      padding: 0.4rem;
      padding-right: 0.2rem;
    }
  }
</style>
