// Stands in for src/supabaseClient.js when tests/game-completion-hook.test.mjs
// loads the real scorebook hook through Vite. Every call goes to whichever
// fake database the test has installed, so a "reload" is installing a fresh
// client over the same rows.
export const supabase = {
  from: (...args) => globalThis.__GAME_COMPLETION_SUPABASE__.from(...args),
  rpc: (...args) => globalThis.__GAME_COMPLETION_SUPABASE__.rpc(...args),
  channel() { throw new Error('realtime is not used by this test') },
  removeChannel() {},
  removeAllChannels: async () => {},
}
