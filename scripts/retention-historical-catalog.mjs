// Pure serialization boundary for the exact native SELECT projection. Keep SQL
// row order and field order; driver array metadata is not catalog evidence.
const FIELDS = ['TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_KEY', 'EXTRA']
function ordinalNumber(value) {
    if (typeof value === 'bigint') {
        if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('catalog ordinal outside positive safe integer range')
        return Number(value)
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError('catalog ordinal must be a positive safe number or bigint')
    return value
}
export function serializeHistoricalCatalogRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('catalog requires a nonempty native row array')
    const canonical = Array.from(rows, row => {
        if (row === null || typeof row !== 'object' || Array.isArray(row)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(row))
            || Reflect.ownKeys(row).length !== FIELDS.length) throw new TypeError('catalog row must be an exact scalar record')
        return Object.fromEntries(FIELDS.map(field => {
            const descriptor = Object.getOwnPropertyDescriptor(row, field)
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError('catalog field must be an own enumerable data value')
            const value = descriptor.value
            if (field === 'ORDINAL_POSITION') return [field, ordinalNumber(value)]
            if (typeof value !== 'string') throw new TypeError('catalog field must be a scalar string')
            return [field, value]
        }))
    })
    return JSON.stringify(canonical)
}
