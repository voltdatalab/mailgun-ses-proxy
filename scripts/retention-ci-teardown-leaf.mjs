// Fixed offline probe, copied into private scratch. Inherited HOST proc view is
// intentional: record global identities before any private proc mount/chroot.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
const role = process.argv[2]
if (!['leaf', 'descendant'].includes(role)) throw new Error('invalid fixed probe role')
const status = readFileSync('/proc/self/status', 'utf8')
const stat = readFileSync('/proc/self/stat', 'utf8')
const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
const identity = { pid: Number(stat.slice(0, stat.indexOf(' '))), ppid: Number(fields[1]), startTime: fields[19],
    nspid: status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number), uid: process.getuid(), gid: process.getgid(),
    uidMap: readFileSync('/proc/self/uid_map', 'utf8'), gidMap: readFileSync('/proc/self/gid_map', 'utf8') }
writeFileSync(`${role}.json`, JSON.stringify(identity), { flag: 'wx', mode: 0o600 })
// Even a broken launcher leaves only fixed, self-expiring fixture children.
let child, completed = false
setTimeout(() => {
    writeFileSync(`${role}-completed`, 'unexpected completion', { flag: 'wx' })
    completed = true
    if (!child || child.exitCode !== null) process.exit(0)
}, 2000)
if (role === 'leaf') {
    child = spawn(process.execPath, [process.argv[1], 'descendant'], { stdio: 'inherit', env: { PATH: '/usr/bin:/bin' } })
    child.on('exit', () => { if (completed) process.exit(0) })
    // Hard fixture lifetime cap, independent of launcher correctness.
    setTimeout(() => process.exit(1), 2600)
    const ready = setInterval(() => {
        let descendant
        try { descendant = JSON.parse(readFileSync('descendant.json', 'utf8')) } catch { return }
        writeFileSync('started.tmp', JSON.stringify({ leaf: identity, descendant }), { flag: 'wx', mode: 0o600 })
        renameSync('started.tmp', 'started.json')
        clearInterval(ready)
    }, 10)
}
