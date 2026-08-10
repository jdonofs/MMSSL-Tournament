import { all } from './db.mjs'
const sched = await all('season_schedule', (q) => q.eq('season_id', 54).eq('status', 'scheduled'))
console.log(sched.slice(0, 3).map((g) => `${g.id} away=${g.away_team_id} home=${g.home_team_id}`).join('\n'))
