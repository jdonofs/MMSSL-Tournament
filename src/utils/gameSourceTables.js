// Tournament and season data live in parallel tables/columns — every page
// that needs to switch between them by a `source` param ('tournament' |
// 'season') keys off these same two maps.
export const TABLES = {
  tournament: { pa: 'plate_appearances', pitches: 'pitches', games: 'games' },
  season: { pa: 'season_plate_appearances', pitches: 'season_pitches', games: 'season_schedule' },
}

// Only games that have actually been played have anything to score.
// Tournament and season games use different status vocabularies for "done".
export const PLAYED_STATUS = {
  tournament: 'complete',
  season: 'completed',
}
