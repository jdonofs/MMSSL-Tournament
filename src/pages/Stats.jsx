import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useTournament } from '../context/TournamentContext'
import {
  buildCharacterHistory,
  buildCharacterTournamentHistory,
  buildHeadToHead,
  buildStandings,
  groupBy,
  summarizeBatting,
  summarizePitching,
} from '../utils/statsCalculator'
import { CAPTAIN_TEAM_MAP } from '../utils/teamIdentity'
import CharacterPortrait from '../components/CharacterPortrait'
import PlayerTag from '../components/PlayerTag'
import { getChemistry } from '../data/chemistry'

const CHARACTER_VIEWS = {
  batting: 'batting',
  pitching: 'pitching',
}

function formatDecimal(value, digits = 3, fallback = '-') {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
}

function formatInteger(value) {
  return Number.isFinite(value) ? String(value) : '-'
}

function StatPill({ label, value, accent = '#EAB308' }) {
  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '0.75rem 0.9rem', background: 'rgba(255,255,255,0.03)' }}>
      <div style={{ color: '#94A3B8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ color: accent, fontSize: 20, fontWeight: 800, marginTop: 4 }}>{value}</div>
    </div>
  )
}

function DetailStatGrid({ stats }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
      {stats.map((stat) => (
        <StatPill key={stat.label} label={stat.label} value={stat.value} accent={stat.accent} />
      ))}
    </div>
  )
}

function CharacterDetailModal({
  character,
  allCharactersById,
  playersById,
  identitiesByPlayerId,
  currentTournamentBatting,
  currentTournamentPitching,
  allTimeBatting,
  allTimePitching,
  battingHistory = [],
  pitchingHistory = [],
  currentOwner,
  totalDrafts,
  tournamentsDrafted,
  championshipsWon,
  onClose,
}) {
  if (!character) return null

  const chemistry = getChemistry(character.name)
  const portraitButtonStyle = {
    background: 'none',
    border: 'none',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#F8FAFC',
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 960, maxHeight: '90vh', overflowY: 'auto' }} onClick={(event) => event.stopPropagation()}>
        <div className="section-head" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', overflow: 'hidden', border: '2px solid #EAB308', flexShrink: 0 }}>
              <CharacterPortrait name={character.name} size={72} />
            </div>
            <div>
              <h2 style={{ margin: 0 }}>{character.name}</h2>
              <div className="muted" style={{ marginTop: 4 }}>
                {currentOwner
                  ? <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={currentOwner.player_id} playersById={playersById} />
                  : 'Undrafted in selected view'}
              </div>
            </div>
          </div>
          <button onClick={onClose} type="button" style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <div className="page-stack">
          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>Character Info</h3>
              <div className="muted">All available data for this character</div>
            </div>
            <DetailStatGrid
              stats={[
                { label: 'Pitching', value: formatInteger(character.pitching), accent: '#EF4444' },
                { label: 'Batting', value: formatInteger(character.batting), accent: '#22C55E' },
                { label: 'Fielding', value: formatInteger(character.fielding), accent: '#3B82F6' },
                { label: 'Speed', value: formatInteger(character.speed), accent: '#EAB308' },
                { label: 'Drafted', value: formatInteger(totalDrafts), accent: '#F8FAFC' },
                { label: 'Tournaments', value: formatInteger(tournamentsDrafted), accent: '#F8FAFC' },
                { label: 'Titles', value: formatInteger(championshipsWon), accent: '#F8FAFC' },
              ]}
            />
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>Current Tournament</h3>
              <div className="muted">Selected tournament view</div>
            </div>
            <div className="page-stack">
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Batting</div>
                <DetailStatGrid
                  stats={[
                    { label: 'PA', value: formatInteger(currentTournamentBatting.plateAppearances) },
                    { label: 'AB', value: formatInteger(currentTournamentBatting.atBats) },
                    { label: 'H', value: formatInteger(currentTournamentBatting.hits) },
                    { label: 'R', value: formatInteger(currentTournamentBatting.runs) },
                    { label: 'RBI', value: formatInteger(currentTournamentBatting.rbi) },
                    { label: 'HR', value: formatInteger(currentTournamentBatting.homeRuns) },
                    { label: 'AVG', value: formatDecimal(currentTournamentBatting.avg) },
                    { label: 'OPS', value: formatDecimal(currentTournamentBatting.ops) },
                  ]}
                />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Pitching</div>
                <DetailStatGrid
                  stats={[
                    { label: 'IP', value: formatDecimal(currentTournamentPitching.innings, 1) },
                    { label: 'W', value: formatInteger(currentTournamentPitching.wins) },
                    { label: 'L', value: formatInteger(currentTournamentPitching.losses) },
                    { label: 'SV', value: formatInteger(currentTournamentPitching.saves) },
                    { label: 'K', value: formatInteger(currentTournamentPitching.strikeouts) },
                    { label: 'ERA/3', value: formatDecimal(currentTournamentPitching.era, 2) },
                    { label: 'WHIP', value: formatDecimal(currentTournamentPitching.whip, 2) },
                    { label: 'K/3', value: formatDecimal(currentTournamentPitching.kPer3, 2) },
                  ]}
                />
              </div>
            </div>
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>All-Time Performance</h3>
              <div className="muted">Across all tournaments</div>
            </div>
            <div className="page-stack">
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Batting</div>
                <DetailStatGrid
                  stats={[
                    { label: 'Games', value: formatInteger(allTimeBatting.games) },
                    { label: 'PA', value: formatInteger(allTimeBatting.plateAppearances) },
                    { label: 'AB', value: formatInteger(allTimeBatting.atBats) },
                    { label: 'H', value: formatInteger(allTimeBatting.hits) },
                    { label: '2B', value: formatInteger(allTimeBatting.doubles) },
                    { label: '3B', value: formatInteger(allTimeBatting.triples) },
                    { label: 'HR', value: formatInteger(allTimeBatting.homeRuns) },
                    { label: 'BB', value: formatInteger(allTimeBatting.walks) },
                    { label: 'HBP', value: formatInteger(allTimeBatting.hbp) },
                    { label: 'SO', value: formatInteger(allTimeBatting.strikeouts) },
                    { label: 'R', value: formatInteger(allTimeBatting.runs) },
                    { label: 'RBI', value: formatInteger(allTimeBatting.rbi) },
                    { label: 'TB', value: formatInteger(allTimeBatting.totalBases) },
                    { label: 'AVG', value: formatDecimal(allTimeBatting.avg) },
                    { label: 'OBP', value: formatDecimal(allTimeBatting.obp) },
                    { label: 'SLG', value: formatDecimal(allTimeBatting.slg) },
                    { label: 'OPS', value: formatDecimal(allTimeBatting.ops) },
                  ]}
                />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Pitching</div>
                <DetailStatGrid
                  stats={[
                    { label: 'Games', value: formatInteger(allTimePitching.games) },
                    { label: 'IP', value: formatDecimal(allTimePitching.innings, 1) },
                    { label: 'W', value: formatInteger(allTimePitching.wins) },
                    { label: 'L', value: formatInteger(allTimePitching.losses) },
                    { label: 'SV', value: formatInteger(allTimePitching.saves) },
                    { label: 'CG', value: formatInteger(allTimePitching.completeGames) },
                    { label: 'SHO', value: formatInteger(allTimePitching.shutouts) },
                    { label: 'K', value: formatInteger(allTimePitching.strikeouts) },
                    { label: 'H', value: formatInteger(allTimePitching.hitsAllowed) },
                    { label: 'R', value: formatInteger(allTimePitching.runsAllowed) },
                    { label: 'ER', value: formatInteger(allTimePitching.earnedRuns) },
                    { label: 'BB', value: formatInteger(allTimePitching.walks) },
                    { label: 'HR', value: formatInteger(allTimePitching.homeRunsAllowed) },
                    { label: 'ERA/3', value: formatDecimal(allTimePitching.era, 2) },
                    { label: 'WHIP', value: formatDecimal(allTimePitching.whip, 2) },
                    { label: 'K/3', value: formatDecimal(allTimePitching.kPer3, 2) },
                    { label: 'HR/3', value: formatDecimal(allTimePitching.hrPer3, 2) },
                  ]}
                />
              </div>
            </div>
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>Chemistry</h3>
              <div className="muted">Roster chemistry relationships</div>
            </div>
            <div className="page-stack">
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Good</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  {chemistry.good.length ? chemistry.good.map((name) => (
                    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.45rem 0.6rem', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }}>
                      <CharacterPortrait name={name} size={32} />
                      <span>{allCharactersById[name]?.name || name}</span>
                    </div>
                  )) : <span className="muted">None</span>}
                </div>
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Bad</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  {chemistry.bad.length ? chemistry.bad.map((name) => (
                    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.45rem 0.6rem', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }}>
                      <CharacterPortrait name={name} size={32} />
                      <span>{allCharactersById[name]?.name || name}</span>
                    </div>
                  )) : <span className="muted">None</span>}
                </div>
              </div>
            </div>
          </section>

          <section className="panel" style={{ padding: '1rem' }}>
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3>Tournament History</h3>
              <div className="muted">Per-tournament batting and pitching</div>
            </div>
            <div className="page-stack">
              <div style={{ overflowX: 'auto' }}>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Batting</div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tournament</th>
                      <th>PA</th>
                      <th>AVG</th>
                      <th>OPS</th>
                      <th>HR</th>
                      <th>RBI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {battingHistory.length ? battingHistory.map((entry) => (
                      <tr key={`bat-${entry.tournamentId}`}>
                        <td>Tournament {entry.tournamentNumber}</td>
                        <td>{entry.pa}</td>
                        <td>{formatDecimal(entry.avg)}</td>
                        <td>{formatDecimal(entry.ops)}</td>
                        <td>{entry.hr}</td>
                        <td>{entry.rbi}</td>
                      </tr>
                    )) : (
                      <tr><td colSpan={6} className="muted">No batting history.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <div className="muted" style={{ marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Pitching</div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tournament</th>
                      <th>IP</th>
                      <th>ERA/3</th>
                      <th>WHIP</th>
                      <th>K</th>
                      <th>W-L-SV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pitchingHistory.length ? pitchingHistory.map((entry) => (
                      <tr key={`pit-${entry.tournamentId}`}>
                        <td>Tournament {entry.tournamentNumber}</td>
                        <td>{formatDecimal(entry.innings, 1)}</td>
                        <td>{formatDecimal(entry.era, 2)}</td>
                        <td>{formatDecimal(entry.whip, 2)}</td>
                        <td>{entry.strikeouts}</td>
                        <td>{entry.wins}-{entry.losses}-{entry.saves}</td>
                      </tr>
                    )) : (
                      <tr><td colSpan={6} className="muted">No pitching history.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default function Stats() {
  const { viewedTournament, currentTournament } = useTournament()
  const [tab, setTab] = useState('players')
  const [characterView, setCharacterView] = useState(CHARACTER_VIEWS.batting)
  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [games, setGames] = useState([])
  const [draftPicks, setDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [selectedTournamentId, setSelectedTournamentId] = useState('')
  const [tournaments, setTournaments] = useState([])
  const [headToHead, setHeadToHead] = useState({ playerOneId: '', playerTwoId: '' })
  const [characterSort, setCharacterSort] = useState({ key: 'name', direction: 'asc' })
  const [selectedCharacterId, setSelectedCharacterId] = useState(null)

  const defaultTournamentId = useMemo(
    () => String(viewedTournament?.id || currentTournament?.id || tournaments[0]?.id || ''),
    [viewedTournament?.id, currentTournament?.id, tournaments],
  )

  const selectedTournamentValue = selectedTournamentId || defaultTournamentId || 'all'

  useEffect(() => {
    const loadStats = async () => {
      const [{ data: playersData }, { data: charactersData }, { data: gamesData }, { data: picksData }, { data: paData }, { data: pitchingData }, { data: tournamentsData }] =
        await Promise.all([
          supabase.from('players').select('*'),
          supabase.from('characters').select('*'),
          supabase.from('games').select('*'),
          supabase.from('draft_picks').select('*'),
          supabase.from('plate_appearances').select('*'),
          supabase.from('pitching_stints').select('*'),
          supabase.from('tournaments').select('*').order('tournament_number', { ascending: false }),
        ])

      setPlayers(playersData || [])
      setCharacters(charactersData || [])
      setGames(gamesData || [])
      setDraftPicks(picksData || [])
      setPlateAppearances(paData || [])
      setPitchingStints(pitchingData || [])
      setTournaments(tournamentsData || [])
      if (playersData?.length >= 2) {
        setHeadToHead({ playerOneId: playersData[0].id, playerTwoId: playersData[1].id })
      }
    }

    loadStats()
    const channel = supabase
      .channel(`stats-live-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'characters' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints' }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, loadStats)
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => {
    if (!selectedTournamentId && defaultTournamentId) {
      setSelectedTournamentId(defaultTournamentId)
    }
  }, [selectedTournamentId, defaultTournamentId])

  const playersById = useMemo(() => Object.fromEntries(players.map((player) => [player.id, player])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map((character) => [character.id, character])), [characters])
  const charactersByName = useMemo(() => Object.fromEntries(characters.map((character) => [character.name, character])), [characters])
  const gameById = useMemo(() => Object.fromEntries(games.map((game) => [game.id, game])), [games])
  const tournamentById = useMemo(() => Object.fromEntries(tournaments.map((tournament) => [tournament.id, tournament])), [tournaments])

  const filteredGames = selectedTournamentValue === 'all'
    ? games
    : games.filter((game) => String(game.tournament_id) === String(selectedTournamentValue))
  const filteredPas = selectedTournamentValue === 'all'
    ? plateAppearances
    : plateAppearances.filter((pa) => String(gameById[pa.game_id]?.tournament_id) === String(selectedTournamentValue))
  const filteredPitching = selectedTournamentValue === 'all'
    ? pitchingStints
    : pitchingStints.filter((stint) => String(gameById[stint.game_id]?.tournament_id) === String(selectedTournamentValue))

  const identitiesByPlayerId = useMemo(() => {
    const captainPicks = (
      selectedTournamentValue === 'all'
        ? (() => {
            const recentId = tournaments.length ? String(tournaments[0].id) : null
            const recent = recentId ? draftPicks.filter((pick) => String(pick.tournament_id) === recentId && pick.is_captain && pick.team_logo_key) : []
            return recent.length ? recent : draftPicks.filter((pick) => pick.is_captain && pick.team_logo_key)
          })()
        : draftPicks.filter((pick) => String(pick.tournament_id) === String(selectedTournamentValue) && pick.is_captain && pick.team_logo_key)
    )
    return Object.fromEntries(
      captainPicks.map((pick) => [pick.player_id, {
        playerId: pick.player_id,
        captainCharacterName: pick.captain_character_name,
        teamName: CAPTAIN_TEAM_MAP[pick.captain_character_name]?.teamName || pick.captain_character_name,
        teamLogoKey: pick.team_logo_key,
        draftPickId: pick.id,
      }]),
    )
  }, [draftPicks, selectedTournamentValue, tournaments])

  const standings = buildStandings(filteredGames, players)
  const paByPlayer = groupBy(filteredPas, 'player_id')
  const pitchingByPlayer = groupBy(filteredPitching, 'player_id')
  const allCharacterHistory = useMemo(() => buildCharacterHistory(plateAppearances, pitchingStints), [plateAppearances, pitchingStints])
  const filteredCharacterHistory = useMemo(() => buildCharacterHistory(filteredPas, filteredPitching), [filteredPas, filteredPitching])
  const battingTournamentHistory = useMemo(() => buildCharacterTournamentHistory(plateAppearances, games, tournaments), [plateAppearances, games, tournaments])

  const pitchingTournamentHistory = useMemo(() => {
    const byCharacterTournament = {}
    pitchingStints.forEach((stint) => {
      const game = gameById[stint.game_id]
      if (!game) return
      const charId = stint.character_id
      const tournamentId = game.tournament_id
      if (!byCharacterTournament[charId]) byCharacterTournament[charId] = {}
      if (!byCharacterTournament[charId][tournamentId]) byCharacterTournament[charId][tournamentId] = []
      byCharacterTournament[charId][tournamentId].push(stint)
    })

    return Object.fromEntries(
      Object.entries(byCharacterTournament).map(([characterId, byTournament]) => [
        characterId,
        Object.entries(byTournament)
          .map(([tournamentId, stints]) => {
            const summary = summarizePitching(stints)
            const tournament = tournamentById[tournamentId]
            return {
              tournamentId,
              tournamentNumber: tournament?.tournament_number ?? '?',
              ...summary,
            }
          })
          .sort((a, b) => Number(b.tournamentNumber) - Number(a.tournamentNumber)),
      ]),
    )
  }, [pitchingStints, gameById, tournamentById])

  const relevantPicks = selectedTournamentValue === 'all'
    ? draftPicks
    : draftPicks.filter((pick) => String(pick.tournament_id) === String(selectedTournamentValue))

  const characterRows = useMemo(() => {
    return characters.map((character) => {
      const batting = filteredCharacterHistory[character.id]?.batting || summarizeBatting([])
      const pitching = filteredCharacterHistory[character.id]?.pitching || summarizePitching([])
      const allTimeBatting = allCharacterHistory[character.id]?.batting || summarizeBatting([])
      const allTimePitching = allCharacterHistory[character.id]?.pitching || summarizePitching([])
      const picks = relevantPicks.filter((pick) => pick.character_id === character.id)
      const allPicks = draftPicks.filter((pick) => pick.character_id === character.id)
      const tournamentIdsDrafted = [...new Set(allPicks.map((pick) => String(pick.tournament_id)))]
      const gamesWithCharacter = filteredGames.filter(
        (game) =>
          game.status === 'complete' &&
          picks.some((pick) => pick.tournament_id === game.tournament_id && [game.team_a_player_id, game.team_b_player_id].includes(pick.player_id)),
      ).length
      const winsWithCharacter = filteredGames.filter(
        (game) =>
          game.status === 'complete' &&
          picks.some((pick) => pick.tournament_id === game.tournament_id && pick.player_id === game.winner_player_id),
      ).length
      const championshipsWon = tournamentIdsDrafted.filter((tournamentId) =>
        tournaments.some(
          (tournament) =>
            String(tournament.id) === tournamentId &&
            allPicks.some((pick) => String(pick.tournament_id) === tournamentId && pick.player_id === tournament.champion_player_id),
        ),
      ).length

      return {
        ...character,
        batting,
        pitching,
        allTimeBatting,
        allTimePitching,
        currentOwner: picks.at(-1) || allPicks.at(-1) || null,
        ownerName: playersById[picks.at(-1)?.player_id || allPicks.at(-1)?.player_id]?.name || 'Undrafted',
        totalDrafts: allPicks.length,
        tournamentsDrafted: tournamentIdsDrafted.length,
        championshipsWon,
        gamesWithCharacter,
        winRate: gamesWithCharacter ? winsWithCharacter / gamesWithCharacter : 0,
        combinedScore: (allTimeBatting.ops || 0) + (1 / Math.max(allTimePitching.era || 1, 1)),
      }
    })
  }, [allCharacterHistory, characters, draftPicks, filteredCharacterHistory, filteredGames, playersById, relevantPicks, tournaments])

  const visibleCharacterRows = useMemo(() => {
    const baseRows = characterRows.filter((row) => (
      characterView === CHARACTER_VIEWS.batting
        ? row.batting.plateAppearances > 0
        : row.pitching.innings > 0
    ))

    const getSortValue = (row) => {
      if (characterSort.key === 'name') return row.name
      if (characterSort.key === 'owner') return row.ownerName
      if (characterSort.key === 'winRate') return row.gamesWithCharacter ? row.winRate : null
      if (characterSort.key === 'tournamentsDrafted') return row.tournamentsDrafted
      if (characterSort.key === 'championshipsWon') return row.championshipsWon
      return row[characterView]?.[characterSort.key] ?? null
    }

    return [...baseRows].sort((a, b) => {
      const aValue = getSortValue(a)
      const bValue = getSortValue(b)

      if (aValue == null && bValue == null) return a.name.localeCompare(b.name)
      if (aValue == null) return 1
      if (bValue == null) return -1

      let comparison = 0
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        comparison = aValue.localeCompare(bValue)
      } else {
        comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0
      }

      if (comparison === 0) comparison = a.name.localeCompare(b.name)
      return characterSort.direction === 'asc' ? comparison : -comparison
    })
  }, [characterRows, characterSort, characterView])

  const playerRows = standings.map((standing) => {
    const batting = summarizeBatting(paByPlayer[standing.playerId] || [])
    batting.ops = batting.obp + batting.slg
    const pitching = summarizePitching(pitchingByPlayer[standing.playerId] || [])
    return {
      ...standing,
      avg: batting.avg,
      obp: batting.obp,
      slg: batting.slg,
      ops: batting.ops,
      era: pitching.era,
      whip: pitching.whip,
    }
  })

  const draftSummary = characterRows.map((character) => ({
    ...character,
    draftedCount: character.totalDrafts,
  }))

  const matchup = buildHeadToHead(filteredGames, headToHead.playerOneId, headToHead.playerTwoId)

  const selectedCharacter = useMemo(
    () => characterRows.find((row) => row.id === selectedCharacterId) || null,
    [characterRows, selectedCharacterId],
  )

  const toggleCharacterSort = (key) => {
    setCharacterSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'name' || key === 'owner' ? 'asc' : 'desc' },
    )
  }

  const renderCharacterSortLabel = (label, key) => (
    <button className="table-sort-button" onClick={() => toggleCharacterSort(key)} type="button">
      <span>{label}</span>
    </button>
  )

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <span className="brand-kicker">Historical Stats</span>
          <h1>Players, characters, matchups, and draft value</h1>
        </div>
        <select onChange={(event) => setSelectedTournamentId(event.target.value)} value={selectedTournamentValue}>
          <option value="all">All tournaments</option>
          {tournaments.map((tournament) => (
            <option key={tournament.id} value={tournament.id}>
              Tournament {tournament.tournament_number}
            </option>
          ))}
        </select>
      </div>

      <div className="tab-row">
        <button className={`tab-button ${tab === 'players' ? 'tab-button-active' : ''}`} onClick={() => setTab('players')} type="button">Players</button>
        <button className={`tab-button ${tab === 'characters' ? 'tab-button-active' : ''}`} onClick={() => setTab('characters')} type="button">Characters</button>
        <button className={`tab-button ${tab === 'head' ? 'tab-button-active' : ''}`} onClick={() => setTab('head')} type="button">Head to Head</button>
        <button className={`tab-button ${tab === 'draft' ? 'tab-button-active' : ''}`} onClick={() => setTab('draft')} type="button">Draft Analysis</button>
      </div>

      {tab === 'players' ? (
        <section className="table-card">
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>W</th>
                  <th>L</th>
                  <th>RS</th>
                  <th>RA</th>
                  <th>AVG</th>
                  <th>OBP</th>
                  <th>SLG</th>
                  <th>OPS</th>
                  <th>ERA/3</th>
                  <th>WHIP</th>
                </tr>
              </thead>
              <tbody>
                {playerRows.map((row) => (
                  <tr key={row.playerId}>
                    <td><PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} /></td>
                    <td>{row.wins}</td>
                    <td>{row.losses}</td>
                    <td>{row.runsFor}</td>
                    <td>{row.runsAgainst}</td>
                    <td>{row.avg.toFixed(3)}</td>
                    <td>{row.obp.toFixed(3)}</td>
                    <td>{row.slg.toFixed(3)}</td>
                    <td>{row.ops.toFixed(3)}</td>
                    <td>{row.era.toFixed(2)}</td>
                    <td>{row.whip.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {tab === 'characters' ? (
        <section className="table-card">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button className={`tab-button ${characterView === CHARACTER_VIEWS.batting ? 'tab-button-active' : ''}`} onClick={() => setCharacterView(CHARACTER_VIEWS.batting)} type="button">Batting</button>
            <button className={`tab-button ${characterView === CHARACTER_VIEWS.pitching ? 'tab-button-active' : ''}`} onClick={() => setCharacterView(CHARACTER_VIEWS.pitching)} type="button">Pitching</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {characterView === CHARACTER_VIEWS.batting ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{renderCharacterSortLabel('Character', 'name')}</th>
                    <th>{renderCharacterSortLabel('Owner', 'owner')}</th>
                    <th>{renderCharacterSortLabel('PA', 'plateAppearances')}</th>
                    <th>{renderCharacterSortLabel('AB', 'atBats')}</th>
                    <th>{renderCharacterSortLabel('H', 'hits')}</th>
                    <th>{renderCharacterSortLabel('2B', 'doubles')}</th>
                    <th>{renderCharacterSortLabel('3B', 'triples')}</th>
                    <th>{renderCharacterSortLabel('HR', 'homeRuns')}</th>
                    <th>{renderCharacterSortLabel('BB', 'walks')}</th>
                    <th>{renderCharacterSortLabel('R', 'runs')}</th>
                    <th>{renderCharacterSortLabel('RBI', 'rbi')}</th>
                    <th>{renderCharacterSortLabel('AVG', 'avg')}</th>
                    <th>{renderCharacterSortLabel('OBP', 'obp')}</th>
                    <th>{renderCharacterSortLabel('SLG', 'slg')}</th>
                    <th>{renderCharacterSortLabel('OPS', 'ops')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCharacterRows.map((character) => (
                    <tr key={character.id} onClick={() => setSelectedCharacterId(character.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="character-cell">
                          <CharacterPortrait name={character.name} size={32} />
                          <span>{character.name}</span>
                        </div>
                      </td>
                      <td>{character.currentOwner ? <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={character.currentOwner.player_id} playersById={playersById} /> : character.ownerName}</td>
                      <td>{character.batting.plateAppearances}</td>
                      <td>{character.batting.atBats}</td>
                      <td>{character.batting.hits}</td>
                      <td>{character.batting.doubles}</td>
                      <td>{character.batting.triples}</td>
                      <td>{character.batting.homeRuns}</td>
                      <td>{character.batting.walks}</td>
                      <td>{character.batting.runs}</td>
                      <td>{character.batting.rbi}</td>
                      <td>{formatDecimal(character.batting.avg)}</td>
                      <td>{formatDecimal(character.batting.obp)}</td>
                      <td>{formatDecimal(character.batting.slg)}</td>
                      <td>{formatDecimal(character.batting.ops)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{renderCharacterSortLabel('Character', 'name')}</th>
                    <th>{renderCharacterSortLabel('Owner', 'owner')}</th>
                    <th>{renderCharacterSortLabel('Games', 'games')}</th>
                    <th>{renderCharacterSortLabel('IP', 'innings')}</th>
                    <th>{renderCharacterSortLabel('W', 'wins')}</th>
                    <th>{renderCharacterSortLabel('L', 'losses')}</th>
                    <th>{renderCharacterSortLabel('SV', 'saves')}</th>
                    <th>{renderCharacterSortLabel('K', 'strikeouts')}</th>
                    <th>{renderCharacterSortLabel('H', 'hitsAllowed')}</th>
                    <th>{renderCharacterSortLabel('R', 'runsAllowed')}</th>
                    <th>{renderCharacterSortLabel('ER', 'earnedRuns')}</th>
                    <th>{renderCharacterSortLabel('BB', 'walks')}</th>
                    <th>{renderCharacterSortLabel('HR', 'homeRunsAllowed')}</th>
                    <th>{renderCharacterSortLabel('ERA/3', 'era')}</th>
                    <th>{renderCharacterSortLabel('WHIP', 'whip')}</th>
                    <th>{renderCharacterSortLabel('K/3', 'kPer3')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCharacterRows.map((character) => (
                    <tr key={character.id} onClick={() => setSelectedCharacterId(character.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="character-cell">
                          <CharacterPortrait name={character.name} size={32} />
                          <span>{character.name}</span>
                        </div>
                      </td>
                      <td>{character.currentOwner ? <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={character.currentOwner.player_id} playersById={playersById} /> : character.ownerName}</td>
                      <td>{character.pitching.games}</td>
                      <td>{formatDecimal(character.pitching.innings, 1)}</td>
                      <td>{character.pitching.wins}</td>
                      <td>{character.pitching.losses}</td>
                      <td>{character.pitching.saves}</td>
                      <td>{character.pitching.strikeouts}</td>
                      <td>{character.pitching.hitsAllowed}</td>
                      <td>{character.pitching.runsAllowed}</td>
                      <td>{character.pitching.earnedRuns}</td>
                      <td>{character.pitching.walks}</td>
                      <td>{character.pitching.homeRunsAllowed}</td>
                      <td>{formatDecimal(character.pitching.era, 2)}</td>
                      <td>{formatDecimal(character.pitching.whip, 2)}</td>
                      <td>{formatDecimal(character.pitching.kPer3, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ) : null}

      {tab === 'head' ? (
        <section className="panel">
          <div className="summary-grid">
            <select onChange={(event) => setHeadToHead((current) => ({ ...current, playerOneId: event.target.value }))} value={headToHead.playerOneId}>
              {players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
            </select>
            <select onChange={(event) => setHeadToHead((current) => ({ ...current, playerTwoId: event.target.value }))} value={headToHead.playerTwoId}>
              {players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
            </select>
          </div>
          <div className="summary-grid">
            <article className="summary-card">
              <span className="muted">Games</span>
              <h2>{matchup.games}</h2>
            </article>
            <article className="summary-card">
              <span className="muted">{players.find((player) => player.id === headToHead.playerOneId)?.name} wins</span>
              <h2>{matchup.playerOneWins}</h2>
            </article>
            <article className="summary-card">
              <span className="muted">{players.find((player) => player.id === headToHead.playerTwoId)?.name} wins</span>
              <h2>{matchup.playerTwoWins}</h2>
            </article>
            <article className="summary-card">
              <span className="muted">Run differential</span>
              <h2>{matchup.playerOneRuns - matchup.playerTwoRuns}</h2>
            </article>
          </div>
        </section>
      ) : null}

      {tab === 'draft' ? (
        <section className="table-card">
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Character</th>
                  <th>Times Drafted</th>
                  <th>Win %</th>
                  <th>OPS + ERA/3 Score</th>
                </tr>
              </thead>
              <tbody>
                {draftSummary
                  .sort((a, b) => b.combinedScore - a.combinedScore)
                  .map((character) => (
                    <tr key={character.id} onClick={() => setSelectedCharacterId(character.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="character-cell">
                          <CharacterPortrait name={character.name} size={32} />
                          <span>{character.name}</span>
                        </div>
                      </td>
                      <td>{character.draftedCount}</td>
                      <td>{character.gamesWithCharacter ? `${(character.winRate * 100).toFixed(0)}%` : '-'}</td>
                      <td>{character.combinedScore.toFixed(3)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {selectedCharacter && (
        <CharacterDetailModal
          character={selectedCharacter}
          allCharactersById={charactersByName}
          playersById={playersById}
          identitiesByPlayerId={identitiesByPlayerId}
          currentTournamentBatting={selectedCharacter.batting}
          currentTournamentPitching={selectedCharacter.pitching}
          allTimeBatting={selectedCharacter.allTimeBatting}
          allTimePitching={selectedCharacter.allTimePitching}
          battingHistory={battingTournamentHistory[selectedCharacter.id] || []}
          pitchingHistory={pitchingTournamentHistory[selectedCharacter.id] || []}
          currentOwner={selectedCharacter.currentOwner}
          totalDrafts={selectedCharacter.totalDrafts}
          tournamentsDrafted={selectedCharacter.tournamentsDrafted}
          championshipsWon={selectedCharacter.championshipsWon}
          onClose={() => setSelectedCharacterId(null)}
        />
      )}
    </div>
  )
}
