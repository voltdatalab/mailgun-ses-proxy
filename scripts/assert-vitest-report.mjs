import { readFile } from "node:fs/promises"

const reportPath = process.argv[2] ?? "artifacts/vitest-report.json"
const report = JSON.parse(await readFile(reportPath, "utf8"))
const totals = {
  total: report.numTotalTests ?? 0,
  passed: report.numPassedTests ?? 0,
  failed: report.numFailedTests ?? 0,
  skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
}

console.log(`vitest totals: total=${totals.total} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`)
if (!totals.total || totals.failed || totals.skipped || totals.passed !== totals.total) {
  process.exitCode = 1
}
