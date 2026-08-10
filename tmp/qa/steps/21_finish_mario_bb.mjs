import { writeFileSync } from 'fs'
import { openGame, clickPitch, currentBatterName } from '../scorebook.mjs'

export default async function (page) {
  await openGame(page)
  console.log('batter:', await currentBatterName(page))
  while ((await currentBatterName(page)) === 'Mario') {
    await clickPitch(page, 'BALL')
  }
  console.log('now batting:', await currentBatterName(page))
  writeFileSync(new URL('../game1_progress.json', import.meta.url), JSON.stringify({ done: 1 }))
}
