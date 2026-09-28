// The Scouting Report's module graph reaches the Supabase client. This fixture
// renders one pure component out of that graph and must not be able to talk to
// a database by accident, so every entry point here throws rather than
// returning an empty result -- an accidental read fails the test loudly
// instead of quietly rendering nothing.
const refuse = (what) => () => {
  throw new Error(`scouting fixture: ${what} is not available; this fixture is offline`)
}

export const supabase = {
  auth: {
    getSession: refuse('auth.getSession'),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithPassword: refuse('auth.signInWithPassword'),
    updateUser: refuse('auth.updateUser'),
    signOut: refuse('auth.signOut'),
  },
  from: refuse('from()'),
  rpc: refuse('rpc()'),
  channel: refuse('channel()'),
  removeChannel() {},
  removeAllChannels: async () => {},
}

export default supabase
