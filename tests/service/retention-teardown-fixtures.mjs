// Synthetic schema fixtures only: never real root/kernel/hosted capability proof.
export function syntheticStartup() {
    return {
        leaf: { pid: 101, ppid: 100, startTime: '123', nspid: [101, 1], uid: 0, gid: 0, uidMap: '0 0 2', gidMap: '0 0 2' },
        descendant: { pid: 102, ppid: 101, startTime: '124', nspid: [102, 2], uid: 0, gid: 0, uidMap: '0 0 2', gidMap: '0 0 2' },
    }
}
/** @type {Array<[string, (started: object) => object | null | undefined]>} */
export const malformedStartupCases = [
    ['missing', () => undefined],
    ['null', () => null],
    ['empty', () => ({})],
    ['partial reported reproducer', () => ({ leaf: { pid: 1, startTime: '' }, descendant: null })],
    ['wrong parent', started => { started.descendant.ppid = 999; return started }],
    ['same host PID', started => { started.descendant.pid = started.leaf.pid; started.descendant.nspid[0] = started.leaf.pid; return started }],
    ...['leaf', 'descendant'].flatMap(role => [
        ['missing identity', undefined], ['null identity', null],
        ['PID <= 1', { pid: 1 }], ['fractional PID', { pid: 1.5 }], ['string PID', { pid: '101' }], ['unsafe PID', { pid: Number.MAX_SAFE_INTEGER + 1 }],
        ['empty start time', { startTime: '' }], ['numeric start time', { startTime: 123 }], ['nondigit start time', { startTime: '12x' }],
        ['nonroot UID', { uid: 1 }], ['nonroot GID', { gid: 1 }],
        ['missing NSpid', { nspid: undefined }], ['no PID namespace', { nspid: [role === 'leaf' ? 101 : 102] }],
        ['wrong global NSpid', { nspid: [999, role === 'leaf' ? 1 : 2] }],
        ['wrong namespace PID', { nspid: [role === 'leaf' ? 101 : 102, role === 'leaf' ? 2 : 1] }],
        ['nonnumeric namespace PID', { nspid: [role === 'leaf' ? 101 : 102, role === 'leaf' ? '1' : '2'] }],
        ['invalid intermediate NSpid', { nspid: [role === 'leaf' ? 101 : 102, null, role === 'leaf' ? 1 : 2] }],
        ['missing UID map', { uidMap: undefined }], ['wrong UID map', { uidMap: '0 0 1' }],
        ['missing GID map', { gidMap: undefined }], ['wrong GID map', { gidMap: '0 0 2\n2 2 1' }],
    ].map(([name, replacement]) => [`${role}: ${name}`, started => {
        if (replacement == null) started[role] = replacement
        else Object.assign(started[role], replacement)
        return started
    }])),
]
