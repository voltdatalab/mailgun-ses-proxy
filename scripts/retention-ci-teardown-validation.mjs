// Pure schema validation shared by the live probe and the report consumer.
// Acceptance of a synthetic object is not proof of actual hosted capability.
export function validateTeardownStartup(started) {
    if (!started?.leaf || !started?.descendant) throw new Error('teardown probe: startup missing')
    for (const identity of [started.leaf, started.descendant]) {
        if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1
            || typeof identity.startTime !== 'string' || !/^\d+$/.test(identity.startTime)
            || identity.uid !== 0 || identity.gid !== 0
            || !Array.isArray(identity.nspid) || identity.nspid.length < 2
            || !identity.nspid.every(pid => Number.isSafeInteger(pid) && pid > 0)
            || identity.nspid[0] !== identity.pid
            || typeof identity.uidMap !== 'string' || !/^\s*0\s+0\s+2\s*$/.test(identity.uidMap)
            || typeof identity.gidMap !== 'string' || !/^\s*0\s+0\s+2\s*$/.test(identity.gidMap)) {
            throw new Error('teardown probe: invalid startup identity/maps')
        }
    }
    if (started.leaf.pid === started.descendant.pid || started.descendant.ppid !== started.leaf.pid
        || started.leaf.nspid.at(-1) !== 1 || started.descendant.nspid.at(-1) <= 1) {
        throw new Error('teardown probe: invalid descendant/PID namespace')
    }
}
