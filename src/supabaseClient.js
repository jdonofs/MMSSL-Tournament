import { createClient } from '@supabase/supabase-js'

const viteEnv = import.meta.env || {}
const processEnv = typeof process !== 'undefined' ? process.env || {} : {}
const supabaseUrl = viteEnv.VITE_SUPABASE_URL || processEnv.VITE_SUPABASE_URL
const supabaseAnonKey = viteEnv.VITE_SUPABASE_ANON_KEY || processEnv.VITE_SUPABASE_ANON_KEY

function buildUnconfiguredClient() {
  return {
    auth: {
      getSession: async () => ({ data: { session: null }, error: new Error('Supabase client not configured') }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: async () => ({ data: null, error: new Error('Supabase client not configured') }),
      updateUser: async () => ({ data: null, error: new Error('Supabase client not configured') }),
      signOut: async () => ({ error: new Error('Supabase client not configured') }),
    },
    from() {
      throw new Error('Supabase client not configured')
    },
    rpc() {
      throw new Error('Supabase client not configured')
    },
    channel() {
      throw new Error('Supabase client not configured')
    },
    removeChannel() {},
    removeAllChannels: async () => {},
  }
}

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : buildUnconfiguredClient()
