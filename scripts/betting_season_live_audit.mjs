import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function loadDotEnv() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const envPath = path.resolve(scriptDir, '..', '.env')
  const raw = fs.readFileSync(envPath, 'utf8')
  raw
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/^([^=]+)=(.*)$/)
      if (!match) return
      const [, key, value] = match
      if (!process.env[key]) process.env[key] = value
    })
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function inferWinningSideOdds(row, side) {
  const probability = Number(row.predicted_probability ?? 0.5)
  switch (row.bet_type) {
    case 'moneyline':
    case 'run_line':
      return side === 'home'
        ? { odds: Number(row.odds_home), predictedProbability: probability }
        : { odds: Number(row.odds_away), predictedProbability: 1 - probability }
    case 'over_under':
    case 'k_prop':
    case 'hr_prop':
    case 'hit_prop':
      return side === 'over'
        ? { odds: Number(row.odds_over), predictedProbability: probability }
        : { odds: Number(row.odds_under), predictedProbability: 1 - probability }
    case 'first_inning_run':
      return side === 'yes'
        ? { odds: Number(row.odds_yes), predictedProbability: probability }
        : { odds: Number(row.odds_no), predictedProbability: 1 - probability }
    default:
      throw new Error(`Unsupported row type for odds lookup: ${row.bet_type}`)
  }
}

function buildResolutionConfig(seasonId) {
  return {
    betsTable: 'season_bets',
    gameOddsTable: 'season_game_odds',
    ledgerTable: 'season_betting_ledger',
    plateAppearancesTable: 'season_plate_appearances',
    runsScoredTable: 'season_runs_scored',
    wagerField: 'wager_dollars',
    payoutField: 'potential_payout_dollars',
    ledgerChangeField: 'dollars_change',
    sourceIdField: 'season_id',
    sourceIdValue: seasonId,
    enableCalibrationLogging: false,
    enableWeightAdjustment: false,
  }
}

async function main() {
  loadDotEnv()

  const [
    { supabase },
    {
      buildPlacedBetLedgerEntries,
      resolveGameBets,
      resolveFirstInningNoRun,
      reopenGameBets,
    },
    { calculatePayout },
  ] = await Promise.all([
    import('../src/supabaseClient.js'),
    import('../src/utils/betResolution.js'),
    import('../src/utils/oddsEngine.js'),
  ])

  const auditEmail = process.env.BETTING_AUDIT_EMAIL
  const auditPassword = process.env.BETTING_AUDIT_PASSWORD
  const auditSeasonName = process.env.BETTING_AUDIT_SEASON || 'TEST'
  const placementMode = process.env.BETTING_AUDIT_PLACEMENT_MODE || 'rpc'

  if (!auditEmail || !auditPassword) {
    throw new Error('BETTING_AUDIT_EMAIL and BETTING_AUDIT_PASSWORD are required')
  }

  async function must(queryPromise, label) {
    const { data, error } = await queryPromise
    if (error) throw new Error(`${label}: ${error.message}`)
    return data
  }

  async function signIn() {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: auditEmail,
      password: auditPassword,
    })
    if (error) throw new Error(`sign in: ${error.message}`)
    return data.user
  }

  async function loadSeasonFixture(user) {
    const seasonRows = await must(
      supabase.from('seasons').select('id,name,status').eq('name', auditSeasonName).order('id', { ascending: false }).limit(1),
      'load season',
    )
    const season = seasonRows?.[0]
    if (!season) throw new Error(`Missing season named ${auditSeasonName}`)

    let player = await must(
      supabase.from('players').select('id,name,email').eq('id', user.id).maybeSingle(),
      'load player by id',
    )
    if (!player && user.email) {
      player = await must(
        supabase.from('players').select('id,name,email').eq('email', user.email).maybeSingle(),
        'load player by email',
      )
    }
    if (!player && user.email) {
      const fallbackName = user.email.split('@')[0]
      const normalizedName = fallbackName ? fallbackName.slice(0, 1).toUpperCase() + fallbackName.slice(1).toLowerCase() : null
      if (normalizedName) {
        player = await must(
          supabase.from('players').select('id,name,email').eq('name', normalizedName).maybeSingle(),
          'load player by name',
        )
      }
    }
    if (!player) throw new Error(`Missing player row for auth user ${user.id}`)

    const games = await must(
      supabase.from('season_schedule').select('*').eq('season_id', season.id).order('id'),
      'load season games',
    )
    const gameIds = (games || []).map((row) => row.id)
    const odds = gameIds.length
      ? await must(
        supabase.from('season_game_odds').select('*').in('game_id', gameIds).order('id'),
        'load season odds',
      )
      : []
    const inning1Runs = await must(
      supabase.from('season_runs_scored').select('game_id,inning').eq('season_id', season.id).eq('inning', 1),
      'load inning-1 runs',
    )

    return {
      season,
      player,
      games: games || [],
      odds: odds || [],
      inning1RunGameIds: new Set((inning1Runs || []).map((row) => String(row.game_id))),
    }
  }

  function groupOddsByGame(oddsRows) {
    return oddsRows.reduce((map, row) => {
      const key = String(row.game_id)
      if (!map[key]) map[key] = []
      map[key].push(row)
      return map
    }, {})
  }

  function hasBaseMarkets(rows = []) {
    const betTypes = new Set(rows.map((row) => row.bet_type))
    return betTypes.has('moneyline')
      && betTypes.has('run_line')
      && betTypes.has('over_under')
      && betTypes.has('first_inning_run')
  }

  function choosePrimaryGames(games, oddsRows, inning1RunGameIds) {
    const oddsByGameId = groupOddsByGame(oddsRows)
    const scheduledGames = games.filter((game) => ['scheduled', 'pending', 'active', 'in_progress'].includes(game.status))
    const scheduledWithBaseMarkets = scheduledGames.find((game) => hasBaseMarkets(oddsByGameId[String(game.id)] || []))
    const firstInningYesGame = games.find((game) => {
      const rows = oddsByGameId[String(game.id)] || []
      return inning1RunGameIds.has(String(game.id)) && rows.some((row) => row.bet_type === 'first_inning_run')
    })
    return {
      scheduledGame: scheduledWithBaseMarkets || scheduledGames[0] || null,
      firstInningYesGame: firstInningYesGame || null,
      oddsByGameId,
    }
  }

  function pickMarketRows(oddsRows, scheduledGameId) {
    const unlockedRows = oddsRows.filter((row) => !row.is_locked)
    const scheduledRows = unlockedRows.filter((row) => String(row.game_id) === String(scheduledGameId))
    const chooseRow = (betType) => scheduledRows.find((row) => row.bet_type === betType)
      || unlockedRows.find((row) => row.bet_type === betType)
      || null

    return {
      moneyline: chooseRow('moneyline'),
      runLine: chooseRow('run_line'),
      overUnder: chooseRow('over_under'),
      kProp: chooseRow('k_prop'),
      hrProp: chooseRow('hr_prop'),
      hitProp: chooseRow('hit_prop'),
      firstInning: chooseRow('first_inning_run'),
    }
  }

  function buildSeasonBetPayload({ playerId, seasonId, row, side, wagerDollars = 1 }) {
    const { odds, predictedProbability } = inferWinningSideOdds(row, side)
    return {
      season_id: seasonId,
      game_id: row.game_id,
      game_odds_id: row.id,
      player_id: playerId,
      bet_type: row.bet_type,
      target_entity: row.target_entity,
      chosen_side: side,
      odds,
      predicted_probability: Math.round(Number(predictedProbability || 0) * 10000) / 10000,
      line: row.line,
      wager_dollars: wagerDollars,
      potential_payout_dollars: calculatePayout(wagerDollars, odds),
      status: 'open',
      placed_at: new Date().toISOString(),
    }
  }

  async function placeSeasonSlipRaw(payloads, seasonId) {
    if (placementMode === 'legacy') {
      const insertPayloads = payloads.map(({ game_odds_id: _ignoredGameOddsId, ...payload }) => payload)
      const insertedBets = await must(
        supabase.from('season_bets').insert(insertPayloads).select(),
        `insert season slip (${payloads.length})`,
      )
      const ledgerRows = buildPlacedBetLedgerEntries(insertedBets, {
        sourceIdField: 'season_id',
        sourceIdValue: seasonId,
        ledgerChangeField: 'dollars_change',
        wagerField: 'wager_dollars',
      })
      if (ledgerRows.length) {
        await must(
          supabase.from('season_betting_ledger').insert(ledgerRows),
          `insert season slip ledger (${payloads.length})`,
        )
      }
      return { data: insertedBets || [], error: null }
    }

    const { data, error } = await supabase.rpc('place_season_bets', {
      p_season_id: seasonId,
      p_bets: payloads,
    })
    return { data: data || [], error: error || null }
  }

  async function placeSeasonSlipLikeUi(payloads, seasonId, label = 'place season slip') {
    const { data, error } = await placeSeasonSlipRaw(payloads, seasonId)
    if (error) throw new Error(`${label}: ${error.message}`)
    return data || []
  }

  async function placeSeasonBetLikeUi(payload, seasonId) {
    const placed = await placeSeasonSlipLikeUi([payload], seasonId, `insert season bet ${payload.bet_type}:${payload.chosen_side}`)
    if (placed.length !== 1) throw new Error(`Expected exactly one bet from placement, received ${placed.length}`)
    return placed[0]
  }

  async function loadCurrentBalance(seasonId, playerId) {
    const [ledgerEntries, balanceAwards, sipTransactions] = await Promise.all([
      must(
        supabase.from('season_betting_ledger').select('dollars_change').eq('season_id', seasonId).eq('player_id', playerId),
        'load ledger balance',
      ),
      must(
        supabase.from('balance_awards').select('amount').eq('season_id', seasonId).eq('player_id', playerId),
        'load balance awards',
      ),
      must(
        supabase.from('sip_transactions').select('type,amount_dollars').eq('season_id', seasonId).eq('player_id', playerId),
        'load sip transactions',
      ),
    ])

    const ledgerNet = (ledgerEntries || []).reduce((sum, row) => sum + Number(row.dollars_change || 0), 0)
    const awardsNet = (balanceAwards || []).reduce((sum, row) => sum + Number(row.amount || 0), 0)
    const sipNet = (sipTransactions || []).reduce((sum, row) => {
      const amount = Number(row.amount_dollars || 0)
      return sum + (row.type === 'sell' ? amount : -amount)
    }, 0)
    return roundMoney(100 + ledgerNet + awardsNet + sipNet)
  }

  async function loadPlayerArtifactCounts(seasonId, playerId) {
    const [bets, ledger] = await Promise.all([
      must(
        supabase.from('season_bets').select('id').eq('season_id', seasonId).eq('player_id', playerId),
        'count player season bets',
      ),
      must(
        supabase.from('season_betting_ledger').select('id').eq('season_id', seasonId).eq('player_id', playerId),
        'count player season ledger',
      ),
    ])
    return {
      betCount: (bets || []).length,
      ledgerCount: (ledger || []).length,
    }
  }

  async function restoreOddsLocks(originalLockStates) {
    const updates = originalLockStates.map((row) =>
      supabase
        .from('season_game_odds')
        .update({ is_locked: row.is_locked, updated_at: row.updated_at })
        .eq('id', row.id),
    )
    const results = await Promise.all(updates)
    const failure = results.find((result) => result.error)
    if (failure?.error) throw failure.error
  }

  async function cleanupCreatedArtifacts({ seasonId, createdBetIds, originalLockStates }) {
    if (createdBetIds.length) {
      await must(
        supabase.from('season_betting_ledger').delete().eq('season_id', seasonId).in('bet_id', createdBetIds),
        'cleanup season ledger',
      )
      await must(
        supabase.from('season_bets').delete().eq('season_id', seasonId).in('id', createdBetIds),
        'cleanup season bets',
      )
    }
    if (originalLockStates.length) {
      await restoreOddsLocks(originalLockStates)
    }
  }

  function removeTrackedBetIds(trackedIds, idsToRemove) {
    const removeSet = new Set(idsToRemove.map((id) => String(id)))
    return trackedIds.filter((id) => !removeSet.has(String(id)))
  }

  const createdBetIds = []
  const trackedLockRows = new Map()
  const report = {
    placementMode,
    season: null,
    player: null,
    games: {},
    placementChecks: {},
    overdraw: null,
    markets: null,
    firstInningNoRun: null,
    firstInningYesFallback: null,
    concurrentSettlement: null,
  }

  try {
    const user = await signIn()
    const fixture = await loadSeasonFixture(user)
    const { scheduledGame, firstInningYesGame, oddsByGameId } = choosePrimaryGames(fixture.games, fixture.odds, fixture.inning1RunGameIds)

    if (!scheduledGame) throw new Error(`No scheduled or active game available in season ${fixture.season.id}`)

    const marketRows = pickMarketRows(fixture.odds, scheduledGame.id)
    if (!marketRows.moneyline || !marketRows.runLine || !marketRows.overUnder || !marketRows.firstInning) {
      throw new Error(`Could not find base betting markets for season ${fixture.season.id}`)
    }

    report.season = fixture.season
    report.player = { id: fixture.player.id, name: fixture.player.name }
    report.games = {
      scheduledGameId: scheduledGame.id,
      firstInningYesGameId: firstInningYesGame?.id || null,
      marketRowIds: Object.fromEntries(
        Object.entries(marketRows).filter(([, row]) => row).map(([key, row]) => [key, row.id]),
      ),
    }

    const originalBalance = await loadCurrentBalance(fixture.season.id, fixture.player.id)

    const singleSlipPayload = buildSeasonBetPayload({
      playerId: fixture.player.id,
      seasonId: fixture.season.id,
      row: marketRows.moneyline,
      side: 'home',
      wagerDollars: 5,
    })
    const singleSlipPlaced = await placeSeasonSlipLikeUi([singleSlipPayload], fixture.season.id, 'place single-ticket slip')
    const singleSlipIds = singleSlipPlaced.map((bet) => bet.id)
    createdBetIds.push(...singleSlipIds)
    const singleSlipLedger = await must(
      supabase.from('season_betting_ledger').select('bet_id,dollars_change,reason').eq('season_id', fixture.season.id).in('bet_id', singleSlipIds).order('bet_id'),
      'load single slip ledger',
    )
    report.placementChecks.singleTicketSlip = {
      placedBetCount: singleSlipPlaced.length,
      placedBetIds: singleSlipIds,
      ledgerRowCount: singleSlipLedger.length,
      totalDebit: roundMoney((singleSlipLedger || []).reduce((sum, row) => sum + Number(row.dollars_change || 0), 0)),
      succeeded: singleSlipPlaced.length === 1 && singleSlipLedger.length === 1 && roundMoney(singleSlipLedger[0]?.dollars_change) === -5,
    }
    await cleanupCreatedArtifacts({
      seasonId: fixture.season.id,
      createdBetIds: singleSlipIds,
      originalLockStates: [],
    })
    createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, singleSlipIds))

    const multiSlipSecondaryRow = marketRows.kProp || marketRows.overUnder
    const multiSlipSecondarySide = marketRows.kProp ? 'over' : 'over'
    const multiSlipPayloads = [
      buildSeasonBetPayload({
        playerId: fixture.player.id,
        seasonId: fixture.season.id,
        row: marketRows.moneyline,
        side: 'away',
        wagerDollars: 3,
      }),
      buildSeasonBetPayload({
        playerId: fixture.player.id,
        seasonId: fixture.season.id,
        row: multiSlipSecondaryRow,
        side: multiSlipSecondarySide,
        wagerDollars: 2,
      }),
    ]
    const multiSlipPlaced = await placeSeasonSlipLikeUi(multiSlipPayloads, fixture.season.id, 'place multi-ticket slip')
    const multiSlipIds = multiSlipPlaced.map((bet) => bet.id)
    createdBetIds.push(...multiSlipIds)
    const multiSlipLedger = await must(
      supabase.from('season_betting_ledger').select('bet_id,dollars_change,reason').eq('season_id', fixture.season.id).in('bet_id', multiSlipIds).order('bet_id'),
      'load multi slip ledger',
    )
    report.placementChecks.multiTicketSlip = {
      placedBetCount: multiSlipPlaced.length,
      placedBetIds: multiSlipIds,
      ledgerRowCount: multiSlipLedger.length,
      totalDebit: roundMoney((multiSlipLedger || []).reduce((sum, row) => sum + Number(row.dollars_change || 0), 0)),
      succeeded: multiSlipPlaced.length === 2 && multiSlipLedger.length === 2 && roundMoney((multiSlipLedger || []).reduce((sum, row) => sum + Number(row.dollars_change || 0), 0)) === -5,
    }
    await cleanupCreatedArtifacts({
      seasonId: fixture.season.id,
      createdBetIds: multiSlipIds,
      originalLockStates: [],
    })
    createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, multiSlipIds))

    const oversizedCountsBefore = await loadPlayerArtifactCounts(fixture.season.id, fixture.player.id)
    const oversizedBalanceBefore = await loadCurrentBalance(fixture.season.id, fixture.player.id)
    const oversizedAttempt = await placeSeasonSlipRaw([
      buildSeasonBetPayload({
        playerId: fixture.player.id,
        seasonId: fixture.season.id,
        row: marketRows.moneyline,
        side: 'home',
        wagerDollars: 60,
      }),
      buildSeasonBetPayload({
        playerId: fixture.player.id,
        seasonId: fixture.season.id,
        row: marketRows.overUnder,
        side: 'over',
        wagerDollars: 50,
      }),
    ], fixture.season.id)
    const oversizedCountsAfter = await loadPlayerArtifactCounts(fixture.season.id, fixture.player.id)
    const oversizedBalanceAfter = await loadCurrentBalance(fixture.season.id, fixture.player.id)
    const oversizedIds = (oversizedAttempt.data || []).map((bet) => bet.id)
    if (oversizedIds.length) createdBetIds.push(...oversizedIds)
    report.placementChecks.oversizedSlipRejected = {
      errorMessage: oversizedAttempt.error?.message || null,
      insertedBetIds: oversizedIds,
      countsBefore: oversizedCountsBefore,
      countsAfter: oversizedCountsAfter,
      balanceBefore: oversizedBalanceBefore,
      balanceAfter: oversizedBalanceAfter,
      rejected: Boolean(oversizedAttempt.error)
        && oversizedIds.length === 0
        && oversizedCountsBefore.betCount === oversizedCountsAfter.betCount
        && oversizedCountsBefore.ledgerCount === oversizedCountsAfter.ledgerCount
        && oversizedBalanceBefore === oversizedBalanceAfter,
    }
    if (oversizedIds.length) {
      await cleanupCreatedArtifacts({
        seasonId: fixture.season.id,
        createdBetIds: oversizedIds,
        originalLockStates: [],
      })
      createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, oversizedIds))
    }

    const staleCountsBefore = await loadPlayerArtifactCounts(fixture.season.id, fixture.player.id)
    const staleBalanceBefore = await loadCurrentBalance(fixture.season.id, fixture.player.id)
    const staleMarketAttempt = await placeSeasonSlipRaw([
      {
        ...buildSeasonBetPayload({
          playerId: fixture.player.id,
          seasonId: fixture.season.id,
          row: marketRows.moneyline,
          side: 'home',
          wagerDollars: 1,
        }),
        game_odds_id: -1,
      },
    ], fixture.season.id)
    const staleCountsAfter = await loadPlayerArtifactCounts(fixture.season.id, fixture.player.id)
    const staleBalanceAfter = await loadCurrentBalance(fixture.season.id, fixture.player.id)
    const staleIds = (staleMarketAttempt.data || []).map((bet) => bet.id)
    if (staleIds.length) createdBetIds.push(...staleIds)
    report.placementChecks.staleMarketRejected = {
      errorMessage: staleMarketAttempt.error?.message || null,
      insertedBetIds: staleIds,
      countsBefore: staleCountsBefore,
      countsAfter: staleCountsAfter,
      balanceBefore: staleBalanceBefore,
      balanceAfter: staleBalanceAfter,
      rejected: Boolean(staleMarketAttempt.error)
        && staleIds.length === 0
        && staleCountsBefore.betCount === staleCountsAfter.betCount
        && staleCountsBefore.ledgerCount === staleCountsAfter.ledgerCount
        && staleBalanceBefore === staleBalanceAfter,
    }
    if (staleIds.length) {
      await cleanupCreatedArtifacts({
        seasonId: fixture.season.id,
        createdBetIds: staleIds,
        originalLockStates: [],
      })
      createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, staleIds))
    }

    const concurrentWithinBalanceBefore = await loadCurrentBalance(fixture.season.id, fixture.player.id)
    const [withinFirst, withinSecond] = await Promise.all([
      placeSeasonSlipRaw([
        buildSeasonBetPayload({
          playerId: fixture.player.id,
          seasonId: fixture.season.id,
          row: marketRows.moneyline,
          side: 'home',
          wagerDollars: 40,
        }),
      ], fixture.season.id),
      placeSeasonSlipRaw([
        buildSeasonBetPayload({
          playerId: fixture.player.id,
          seasonId: fixture.season.id,
          row: marketRows.moneyline,
          side: 'away',
          wagerDollars: 40,
        }),
      ], fixture.season.id),
    ])
    const withinBalancePlaced = [...(withinFirst.data || []), ...(withinSecond.data || [])]
    const withinBalanceIds = withinBalancePlaced.map((bet) => bet.id)
    createdBetIds.push(...withinBalanceIds)
    const concurrentWithinBalanceAfter = await loadCurrentBalance(fixture.season.id, fixture.player.id)
    report.placementChecks.concurrentWithinBalance = {
      errorMessages: [withinFirst.error?.message || null, withinSecond.error?.message || null].filter(Boolean),
      createdBetIds: withinBalanceIds,
      successCount: withinBalancePlaced.length,
      balanceBefore: concurrentWithinBalanceBefore,
      balanceAfter: concurrentWithinBalanceAfter,
      allAccepted: withinBalancePlaced.length === 2
        && !withinFirst.error
        && !withinSecond.error
        && concurrentWithinBalanceAfter === roundMoney(concurrentWithinBalanceBefore - 80),
    }
    await cleanupCreatedArtifacts({
      seasonId: fixture.season.id,
      createdBetIds: withinBalanceIds,
      originalLockStates: [],
    })
    createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, withinBalanceIds))

    const overdrawPayloads = [
      buildSeasonBetPayload({ playerId: fixture.player.id, seasonId: fixture.season.id, row: marketRows.moneyline, side: 'home', wagerDollars: 80 }),
      buildSeasonBetPayload({ playerId: fixture.player.id, seasonId: fixture.season.id, row: marketRows.moneyline, side: 'away', wagerDollars: 80 }),
    ]
    const overdrawBalanceBefore = await loadCurrentBalance(fixture.season.id, fixture.player.id)
    const [overdrawFirst, overdrawSecond] = await Promise.all(overdrawPayloads.map((payload) => placeSeasonSlipRaw([payload], fixture.season.id)))
    const concurrentBets = [...(overdrawFirst.data || []), ...(overdrawSecond.data || [])]
    concurrentBets.forEach((bet) => createdBetIds.push(bet.id))
    const overdrawBalance = await loadCurrentBalance(fixture.season.id, fixture.player.id)
    report.overdraw = {
      createdBetIds: concurrentBets.map((bet) => bet.id),
      errorMessages: [overdrawFirst.error?.message || null, overdrawSecond.error?.message || null].filter(Boolean),
      successCount: concurrentBets.length,
      balanceBefore: overdrawBalanceBefore,
      balanceAfterConcurrentPlacement: overdrawBalance,
      overdrawPrevented: concurrentBets.length === 1 && overdrawBalance >= 0,
    }
    await cleanupCreatedArtifacts({
      seasonId: fixture.season.id,
      createdBetIds: concurrentBets.map((bet) => bet.id),
      originalLockStates: [],
    })
    createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, concurrentBets.map((bet) => bet.id)))

    const resolutionBets = []
    const rowsToExercise = [
      [marketRows.moneyline, ['home', 'away']],
      [marketRows.runLine, ['home', 'away']],
      [marketRows.overUnder, ['over', 'under']],
      [marketRows.kProp, ['over', 'under']],
      [marketRows.hrProp, ['over', 'under']],
      [marketRows.hitProp, ['over', 'under']],
    ].filter(([row]) => row)

    for (const [row, sides] of rowsToExercise) {
      for (const side of sides) {
        const bet = await placeSeasonBetLikeUi(
          buildSeasonBetPayload({
            playerId: fixture.player.id,
            seasonId: fixture.season.id,
            row,
            side,
            wagerDollars: 1,
          }),
          fixture.season.id,
        )
        createdBetIds.push(bet.id)
        resolutionBets.push(bet)
      }
    }

    const gamePlans = new Map()
    for (const [row] of rowsToExercise) {
      const key = String(row.game_id)
      if (!gamePlans.has(key)) {
        gamePlans.set(key, {
          gameId: row.game_id,
          winningSide: 'home',
          totalRuns: 6,
          pitcherKTotals: {},
          margin: 2,
          hrTotals: {},
          hitTotals: {},
        })
      }
      const plan = gamePlans.get(key)
      if (row.bet_type === 'run_line') {
        plan.margin = Math.max(2, Math.ceil(Number(row.line || 1.5) + 1))
      }
      if (row.bet_type === 'over_under') {
        plan.totalRuns = Math.max(plan.totalRuns, Math.ceil(Number(row.line || 0) + 1))
      }
      if (row.bet_type === 'k_prop') {
        plan.pitcherKTotals[row.target_entity] = Math.ceil(Number(row.line || 0) + 1)
      }
      if (row.bet_type === 'hr_prop') {
        plan.hrTotals[row.target_entity] = Math.ceil(Number(row.line || 0) + 1)
      }
      if (row.bet_type === 'hit_prop') {
        plan.hitTotals[row.target_entity] = Math.ceil(Number(row.line || 0) + 1)
      }
    }

    for (const plan of gamePlans.values()) {
      await resolveGameBets(
        plan.gameId,
        plan.winningSide,
        plan.totalRuns,
        plan.pitcherKTotals,
        plan.margin,
        buildResolutionConfig(fixture.season.id),
        plan.hrTotals,
        plan.hitTotals,
      )
    }

    const settledResolutionBets = await must(
      supabase.from('season_bets').select('id,game_id,bet_type,chosen_side,status,result_correct').in('id', resolutionBets.map((bet) => bet.id)).order('id'),
      'load settled resolution bets',
    )
    const settledLedgerRows = await must(
      supabase.from('season_betting_ledger').select('bet_id,reason,dollars_change').eq('season_id', fixture.season.id).in('bet_id', resolutionBets.map((bet) => bet.id)).order('bet_id'),
      'load settled resolution ledger',
    )
    report.markets = {
      exercisedBetTypes: Array.from(new Set(settledResolutionBets.map((bet) => bet.bet_type))),
      settledBets: settledResolutionBets,
      ledgerRows: settledLedgerRows,
    }
    await cleanupCreatedArtifacts({
      seasonId: fixture.season.id,
      createdBetIds: resolutionBets.map((bet) => bet.id),
      originalLockStates: [],
    })
    createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, resolutionBets.map((bet) => bet.id)))

    trackedLockRows.set(marketRows.firstInning.id, {
      id: marketRows.firstInning.id,
      is_locked: Boolean(marketRows.firstInning.is_locked),
      updated_at: marketRows.firstInning.updated_at,
    })
    const firstInningNoBets = await Promise.all(['yes', 'no'].map(async (side) => {
      const bet = await placeSeasonBetLikeUi(
        buildSeasonBetPayload({
          playerId: fixture.player.id,
          seasonId: fixture.season.id,
          row: marketRows.firstInning,
          side,
          wagerDollars: 1,
        }),
        fixture.season.id,
      )
      createdBetIds.push(bet.id)
      return bet
    }))

    await resolveFirstInningNoRun(scheduledGame.id, buildResolutionConfig(fixture.season.id))
    const firstInningNoSettled = await must(
      supabase.from('season_bets').select('id,bet_type,chosen_side,status,result_correct').in('id', firstInningNoBets.map((bet) => bet.id)).order('id'),
      'load no-run first-inning bets',
    )
    const firstInningNoLedger = await must(
      supabase.from('season_betting_ledger').select('bet_id,reason,dollars_change').eq('season_id', fixture.season.id).in('bet_id', firstInningNoBets.map((bet) => bet.id)).order('bet_id'),
      'load no-run first-inning ledger',
    )
    await reopenGameBets(scheduledGame.id, buildResolutionConfig(fixture.season.id))
    const firstInningReopened = await must(
      supabase.from('season_bets').select('id,status,result_correct,resolved_at').in('id', firstInningNoBets.map((bet) => bet.id)).order('id'),
      'load reopened first-inning bets',
    )
    report.firstInningNoRun = {
      settledBets: firstInningNoSettled,
      settledLedgerRows: firstInningNoLedger,
      reopenedBets: firstInningReopened,
    }
    await cleanupCreatedArtifacts({
      seasonId: fixture.season.id,
      createdBetIds: firstInningNoBets.map((bet) => bet.id),
      originalLockStates: [],
    })
    createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, firstInningNoBets.map((bet) => bet.id)))

    if (firstInningYesGame) {
      const firstInningYesRow = (oddsByGameId[String(firstInningYesGame.id)] || []).find((row) => row.bet_type === 'first_inning_run')
      if (firstInningYesRow) {
        trackedLockRows.set(firstInningYesRow.id, {
          id: firstInningYesRow.id,
          is_locked: Boolean(firstInningYesRow.is_locked),
          updated_at: firstInningYesRow.updated_at,
        })
        const yesPlacementResults = await Promise.all(['yes', 'no'].map((side) =>
          placeSeasonSlipRaw([
            buildSeasonBetPayload({
              playerId: fixture.player.id,
              seasonId: fixture.season.id,
              row: firstInningYesRow,
              side,
              wagerDollars: 1,
            }),
          ], fixture.season.id),
        ))
        const firstInningYesBets = yesPlacementResults.flatMap((result) => result.data || [])
        const firstInningYesIds = firstInningYesBets.map((bet) => bet.id)
        if (firstInningYesIds.length) createdBetIds.push(...firstInningYesIds)

        if (firstInningYesBets.length === 2 && yesPlacementResults.every((result) => !result.error)) {
          await resolveGameBets(firstInningYesGame.id, 'home', 4, {}, 1, buildResolutionConfig(fixture.season.id))
          const resolvedYesFallback = await must(
            supabase.from('season_bets').select('id,bet_type,chosen_side,status,result_correct').in('id', firstInningYesIds).order('id'),
            'load yes-run first-inning bets',
          )
          const yesFallbackLedger = await must(
            supabase.from('season_betting_ledger').select('bet_id,reason,dollars_change').eq('season_id', fixture.season.id).in('bet_id', firstInningYesIds).order('bet_id'),
            'load yes-run first-inning ledger',
          )
          report.firstInningYesFallback = {
            gameId: firstInningYesGame.id,
            gameStatus: firstInningYesGame.status,
            settledBets: resolvedYesFallback,
            settledLedgerRows: yesFallbackLedger,
          }
          await cleanupCreatedArtifacts({
            seasonId: fixture.season.id,
            createdBetIds: firstInningYesIds,
            originalLockStates: [],
          })
          createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, firstInningYesIds))
        } else {
          report.firstInningYesFallback = {
            gameId: firstInningYesGame.id,
            gameStatus: firstInningYesGame.status,
            placementRejected: true,
            marketLocked: Boolean(firstInningYesRow.is_locked),
            errorMessages: yesPlacementResults.map((result) => result.error?.message || null).filter(Boolean),
          }
          if (firstInningYesIds.length) {
            await cleanupCreatedArtifacts({
              seasonId: fixture.season.id,
              createdBetIds: firstInningYesIds,
              originalLockStates: [],
            })
            createdBetIds.splice(0, createdBetIds.length, ...removeTrackedBetIds(createdBetIds, firstInningYesIds))
          }
        }
      }
    }

    const concurrentSettlementBet = await placeSeasonBetLikeUi(
      buildSeasonBetPayload({
        playerId: fixture.player.id,
        seasonId: fixture.season.id,
        row: marketRows.moneyline,
        side: 'home',
        wagerDollars: 1,
      }),
      fixture.season.id,
    )
    createdBetIds.push(concurrentSettlementBet.id)
    await Promise.all([
      resolveGameBets(marketRows.moneyline.game_id, 'home', 6, {}, 2, buildResolutionConfig(fixture.season.id)),
      resolveGameBets(marketRows.moneyline.game_id, 'home', 6, {}, 2, buildResolutionConfig(fixture.season.id)),
    ])
    const concurrentSettlementLedger = await must(
      supabase
        .from('season_betting_ledger')
        .select('bet_id,reason,dollars_change')
        .eq('season_id', fixture.season.id)
        .eq('bet_id', concurrentSettlementBet.id)
        .like('reason', 'bet_settled:%'),
      'load concurrent settlement ledger',
    )
    report.concurrentSettlement = {
      betId: concurrentSettlementBet.id,
      settledLedgerRowCount: concurrentSettlementLedger.length,
      settledLedgerRows: concurrentSettlementLedger,
      duplicateSettlementPrevented: concurrentSettlementLedger.length === 1,
    }

    console.log(JSON.stringify(report, null, 2))
  } finally {
    try {
      await cleanupCreatedArtifacts({
        seasonId: report.season?.id,
        createdBetIds,
        originalLockStates: Array.from(trackedLockRows.values()),
      })
    } finally {
      await supabase.auth.signOut()
      await supabase.removeAllChannels()
    }
  }
}

await main()
