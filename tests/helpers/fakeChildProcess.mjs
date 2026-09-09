// Child processes that behave like the real ones in the ways the launcher
// depends on, and are steerable in the ways a real one is not.
//
// The launcher's whole job is the seam between processes, and the interesting
// failures live in the ordering there -- a marker printed as the process
// exits, a signal delivered mid-startup, a child that exits 0 without saying
// what it was asked to say. None of those are reachable by spawning the real
// tools, and two of them cannot be reproduced at all against a real Dolphin.
//
// So these fakes give a test the two things node's own child handles hide:
// the exact order of `exit` against the end of stdout, and a kill that the
// child is allowed to ignore.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

let nextPid = 41000

export class FakeChild extends EventEmitter {
  constructor({ command, args, options }) {
    super()
    this.command = command
    this.args = args
    this.options = options
    this.pid = (nextPid += 1)
    this.exitCode = null
    this.signalCode = null
    this.killed = false
    this.killSignals = []
    // Only wired when the caller asked for a pipe, exactly like the real
    // thing: a child spawned with stdio 'inherit' has a null stdout, and a
    // test that reads one is testing something that cannot happen.
    const stdio = options?.stdio
    const wantsPipe = Array.isArray(stdio) ? stdio[1] === 'pipe' : stdio === 'pipe'
    this.stdout = wantsPipe ? new PassThrough() : null
    this.stderr = wantsPipe ? new PassThrough() : null
    // A kill that stops the child is the ordinary case. Set this to keep it
    // running, which is what a child mid-flush does.
    this.ignoreKill = false
  }

  // A whole line, newline included.
  say(line) {
    this.stdout.write(`${line}\n`)
    return this
  }

  // A fragment with no newline, for proving that a marker split across two
  // stdout chunks is still read as one line.
  sayPartial(fragment) {
    this.stdout.write(fragment)
    return this
  }

  // Ends stdout, then exits: the ordinary ordering, where every line the
  // child printed has been delivered before anyone can react to its exit.
  exit(code = 0) {
    if (this.stdout) this.stdout.end()
    this.finish(code)
    return this
  }

  // Exits with stdout still holding unread data. This is the real ordering
  // that broke the handoff: node's `exit` event fires when the process is
  // gone, not when its pipes are drained, so a marker printed immediately
  // before exit can arrive after a handler that already decided it never came.
  exitBeforeStdoutFlush(code = 0, tail = []) {
    this.finish(code)
    queueMicrotask(() => {
      tail.forEach((line) => this.stdout.write(`${line}\n`))
      this.stdout.end()
    })
    return this
  }

  finish(code) {
    if (this.exitCode !== null) return this
    this.exitCode = code
    this.emit('exit', code, null)
    return this
  }

  failToSpawn(error) {
    this.emit('error', error instanceof Error ? error : new Error(String(error)))
    return this
  }

  kill(signal = 'SIGTERM') {
    this.killSignals.push(signal)
    this.killed = true
    if (this.ignoreKill || this.exitCode !== null) return true
    queueMicrotask(() => this.exit(1))
    return true
  }
}

// A spawn() that records everything and hands each new child to a script.
//
// `script` is called with the child before any listener has been attached to
// it, so a test that wants a child to do something immediately has to defer --
// which is why every FakeChild verb is safe to call from a later tick.
export function createFakeSpawner(script = () => {}) {
  const calls = []
  const spawn = (command, args, options = {}) => {
    const child = new FakeChild({ command, args, options })
    const call = { command, args: [...(args || [])], options, child }
    calls.push(call)
    queueMicrotask(() => script(call, calls.length - 1))
    return child
  }
  spawn.calls = calls
  spawn.children = () => calls.map((call) => call.child)
  // Which of the spawned commands ran a given script file. The launcher spawns
  // node twice with different first arguments, so the command alone does not
  // identify them.
  spawn.forScript = (needle) => calls.filter(
    (call) => call.args.some((arg) => String(arg).includes(needle)),
  )
  spawn.oneFor = (needle) => {
    const found = spawn.forScript(needle)
    if (found.length !== 1) {
      throw new Error(`expected exactly one spawn matching ${needle}, got ${found.length}`)
    }
    return found[0]
  }
  return spawn
}

// Waits for a condition the fake children drive, so a test never sleeps for a
// fixed time and never hangs forever without saying what it was waiting for.
export async function waitFor(label, predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
