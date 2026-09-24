export function loadConfig(overrides = {}) {
  const num = (v, d) => {
    if (v === undefined || v === null || v === "") return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    port: num(overrides.PORT ?? process.env.PORT, 8787),
    host: overrides.HOST ?? process.env.HOST ?? "0.0.0.0",
    dbPath: overrides.DB_PATH ?? process.env.DB_PATH ?? "./data/relay.db",
    retentionDays: num(overrides.RETENTION_DAYS ?? process.env.RETENTION_DAYS, 30),
    maxBoxMessages: num(overrides.MAX_BOX_MESSAGES ?? process.env.MAX_BOX_MESSAGES, 10000),
    rateLimitWritesPerMin: num(
      overrides.RATE_LIMIT_WRITES_PER_MIN ?? process.env.RATE_LIMIT_WRITES_PER_MIN,
      60
    ),
    rateLimitReadsPerMin: num(
      overrides.RATE_LIMIT_READS_PER_MIN ?? process.env.RATE_LIMIT_READS_PER_MIN,
      300
    ),
    rateLimitCreatePerIpPerDay: num(
      overrides.RATE_LIMIT_CREATE_PER_IP_PER_DAY ?? process.env.RATE_LIMIT_CREATE_PER_IP_PER_DAY,
      20
    ),
    rateLimitIpWriteFloorPerMin: num(
      overrides.RATE_LIMIT_IP_WRITES_PER_MIN ?? process.env.RATE_LIMIT_IP_WRITES_PER_MIN,
      120
    ),
    rateLimitIpReadFloorPerMin: num(
      overrides.RATE_LIMIT_IP_READS_PER_MIN ?? process.env.RATE_LIMIT_IP_READS_PER_MIN,
      600
    ),
    sweepIntervalMs: num(overrides.SWEEP_INTERVAL_MS ?? process.env.SWEEP_INTERVAL_MS, 60 * 60 * 1000),
    logLevel: overrides.LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info",
    version: "0.1.0",
  };
}
