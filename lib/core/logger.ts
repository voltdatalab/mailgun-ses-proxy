import pino from 'pino';

const validLevels = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"])

function resolveLogLevel() {
    const configuredLevel = process.env.LOG_LEVEL?.toLowerCase()
    if (configuredLevel && validLevels.has(configuredLevel)) {
        return configuredLevel
    }

    return process.env.NODE_ENV != "production" ? "debug" : "info"
}

const logger = pino({
    level: resolveLogLevel(),
});

export default logger.child({ app: "mailgun-ses-proxy" });
