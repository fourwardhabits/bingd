import type { ImageSourcePropType } from 'react-native';

/**
 * One place that says what a badge looks like.
 *
 * Thirty of the sixty tiers have artwork, cut from the founder's sheet by
 * `scripts/awards/build-badges.mjs` and living in `assets/awards/`. The other thirty
 * have an emoji, because ten of the twenty tracks were never drawn and a feature does
 * not wait on a picture.
 *
 * **Every entry is one line, and swapping a placeholder for art is editing that line.**
 * That is the whole reason this table exists rather than a `require` next to each row:
 * when the remaining art arrives, nothing outside this file changes and nothing outside
 * this file needs checking.
 *
 * `require` is used rather than a path string because Metro resolves asset requires at
 * build time — a string would be a runtime lookup that cannot fail until somebody opens
 * the sheet on a device.
 */
export type Badge =
  /** Cut from the sheet. */
  | { kind: 'art'; source: ImageSourcePropType }
  /** Standing in until that tier is drawn. */
  | { kind: 'emoji'; emoji: string };

const art = (source: ImageSourcePropType): Badge => ({ kind: 'art', source });
const emoji = (glyph: string): Badge => ({ kind: 'emoji', emoji: glyph });

/**
 * Keyed `<track>-<tier>`, the same two keys the track config uses, so a badge cannot be
 * attached to a tier that does not exist without the lookup returning nothing — which
 * `badges.test.ts` turns into a failure rather than a silent emoji.
 */
export const BADGES: Record<string, Badge> = {
  // --- Drawn -------------------------------------------------------------
  'movie-muncher-bronze': art(require('../../../assets/awards/movie-muncher-bronze.png')),
  'movie-muncher-silver': art(require('../../../assets/awards/movie-muncher-silver.png')),
  'movie-muncher-gold': art(require('../../../assets/awards/movie-muncher-gold.png')),

  'season-snacker-bronze': art(require('../../../assets/awards/season-snacker-bronze.png')),
  'season-snacker-silver': art(require('../../../assets/awards/season-snacker-silver.png')),
  'season-snacker-gold': art(require('../../../assets/awards/season-snacker-gold.png')),

  'invite-instigator-bronze': art(require('../../../assets/awards/invite-instigator-bronze.png')),
  'invite-instigator-silver': art(require('../../../assets/awards/invite-instigator-silver.png')),
  'invite-instigator-gold': art(require('../../../assets/awards/invite-instigator-gold.png')),

  'queue-dragon-seedling': art(require('../../../assets/awards/queue-dragon-seedling.png')),
  'queue-dragon-hoarder': art(require('../../../assets/awards/queue-dragon-hoarder.png')),
  'queue-dragon-queue-dragon': art(require('../../../assets/awards/queue-dragon-queue-dragon.png')),

  'rating-rascal-scribbler': art(require('../../../assets/awards/rating-rascal-scribbler.png')),
  'rating-rascal-score-goblin': art(require('../../../assets/awards/rating-rascal-score-goblin.png')),
  'rating-rascal-rank-beast': art(require('../../../assets/awards/rating-rascal-rank-beast.png')),

  'comment-gremlin-whisper': art(require('../../../assets/awards/comment-gremlin-whisper.png')),
  'comment-gremlin-chatterbox': art(require('../../../assets/awards/comment-gremlin-chatterbox.png')),
  'comment-gremlin-megaphone': art(require('../../../assets/awards/comment-gremlin-megaphone.png')),

  'hype-courier-nudge': art(require('../../../assets/awards/hype-courier-nudge.png')),
  'hype-courier-messenger': art(require('../../../assets/awards/hype-courier-messenger.png')),
  'hype-courier-hype-train': art(require('../../../assets/awards/hype-courier-hype-train.png')),

  'scream-snack-spooky-sip': art(require('../../../assets/awards/scream-snack-spooky-sip.png')),
  'scream-snack-slash-snack': art(require('../../../assets/awards/scream-snack-slash-snack.png')),
  'scream-snack-nightmare-fuel': art(require('../../../assets/awards/scream-snack-nightmare-fuel.png')),

  'lol-mode-giggle': art(require('../../../assets/awards/lol-mode-giggle.png')),
  'lol-mode-cackle': art(require('../../../assets/awards/lol-mode-cackle.png')),
  'lol-mode-wheeze': art(require('../../../assets/awards/lol-mode-wheeze.png')),

  'softie-hours-sniffle': art(require('../../../assets/awards/softie-hours-sniffle.png')),
  'softie-hours-tearjerker': art(require('../../../assets/awards/softie-hours-tearjerker.png')),
  'softie-hours-sob-lord': art(require('../../../assets/awards/softie-hours-sob-lord.png')),

  // --- Not drawn yet -----------------------------------------------------
  // Ten tracks. The sheet covered the first ten families and stopped, so these stand in
  // until it is extended. Each is one `art(require(...))` away from being finished.
  'space-brain-liftoff': emoji('🚀'),
  'space-brain-moonwalker': emoji('🌕'),
  'space-brain-galaxy-mind': emoji('🌌'),

  'boom-club-spark': emoji('✨'),
  'boom-club-blast': emoji('💥'),
  'boom-club-detonation': emoji('🧨'),

  'toon-bloom-sketch': emoji('✏️'),
  'toon-bloom-ink-pop': emoji('🎨'),
  'toon-bloom-cartoon-chaos': emoji('🌀'),

  'truth-worm-curious': emoji('🔍'),
  'truth-worm-investigator': emoji('🕵️'),
  'truth-worm-deep-dive': emoji('🤿'),

  'passport-mode-hitchhiker': emoji('🧳'),
  'passport-mode-jetsetter': emoji('✈️'),
  'passport-mode-globetrotter': emoji('🌍'),

  'time-hopper-retro-snack': emoji('📼'),
  'time-hopper-vhs-vibes': emoji('📺'),
  'time-hopper-time-traveler': emoji('⏳'),

  'genre-gremlin-dabbler': emoji('🎲'),
  'genre-gremlin-mixer': emoji('🎛️'),
  'genre-gremlin-chaos-collector': emoji('🃏'),

  'two-screen-life-tourist': emoji('🗺️'),
  'two-screen-life-resident': emoji('🏠'),
  'two-screen-life-mayor': emoji('🎖️'),

  'heart-magnet-warmup': emoji('💗'),
  'heart-magnet-favorite': emoji('💖'),
  'heart-magnet-scene-stealer': emoji('🌟'),

  'mutual-mania-hello': emoji('👋'),
  'mutual-mania-inner-circle': emoji('🫂'),
  'mutual-mania-main-character': emoji('👑'),
};

/** The badge for a tier, or a shrug. Never throws: a missing badge is not a crash. */
export const badgeFor = (trackKey: string, tierKey: string): Badge =>
  BADGES[`${trackKey}-${tierKey}`] ?? { kind: 'emoji', emoji: '🏅' };
