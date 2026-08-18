const HOUR_MS = 60 * 60_000;
const MAX_HOURS = 720;
const MAX_DEVICES = 8;
const MAX_BREAKDOWN_ROWS = 8;
const MAX_VALUE = Number.MAX_SAFE_INTEGER;

function integer(value, { nullable = false } = {}) {
  if (value === null || value === undefined || value === '') return nullable ? null : 0;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > MAX_VALUE) return nullable ? null : 0;
  return numeric;
}

function duration(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= MAX_VALUE ? numeric : null;
}

function label(value) {
  return String(value ?? '').replaceAll('\u0000', '').slice(0, 256);
}

function timestamp(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function fieldKnown(row, valueField, knownField) {
  const value = integer(row?.[valueField], { nullable: true });
  if (value === null) return false;
  if (!Object.hasOwn(row ?? {}, knownField)) return true;
  return integer(row?.[knownField]) > 0;
}

function tokenValue(row, valueField, knownField) {
  return fieldKnown(row, valueField, knownField)
    ? integer(row?.[valueField], { nullable: true })
    : null;
}

function completeDeviceField(row, valueField, knownField) {
  const value = integer(row?.[valueField], { nullable: true });
  if (value === null) return null;
  if (!Object.hasOwn(row ?? {}, knownField)) return value;
  const requests = integer(row?.requestCount);
  return requests > 0 && integer(row?.[knownField]) === requests ? value : null;
}

function safeSum(values) {
  let total = 0;
  let known = false;
  for (const value of values) {
    if (value === null) continue;
    known = true;
    total += value;
    if (!Number.isSafeInteger(total) || total < 0) return null;
  }
  return known ? total : null;
}

function deviceInput(row) {
  const values = [
    completeDeviceField(row, 'inputTokens', 'inputTokensKnownCount'),
    completeDeviceField(row, 'cacheCreationInputTokens', 'cacheCreationInputTokensKnownCount'),
    completeDeviceField(row, 'cacheReadInputTokens', 'cacheReadInputTokensKnownCount'),
  ];
  return values.every((value) => value !== null) ? safeSum(values) : null;
}

function deviceOutput(row) {
  return completeDeviceField(row, 'outputTokens', 'outputTokensKnownCount');
}

function bucketsFor(range, ...rowSets) {
  const fromMs = timestamp(range?.fromMs);
  const toMs = timestamp(range?.toMs);
  const requestedHours = integer(range?.hours);
  if (fromMs !== null && toMs !== null && toMs > fromMs && requestedHours > 0 && requestedHours <= MAX_HOURS) {
    const first = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
    const last = Math.floor((toMs - 1) / HOUR_MS) * HOUR_MS;
    const count = Math.floor((last - first) / HOUR_MS) + 1;
    if (count > 0 && count <= MAX_HOURS + 2) {
      return Array.from({ length: count }, (_, index) => first + index * HOUR_MS);
    }
  }
  return [...new Set(rowSets.flatMap((rows) => (
    Array.isArray(rows) ? rows.map((row) => timestamp(row?.hourBucketMs ?? row?.hour_bucket_ms)) : []
  )).filter((value) => value !== null))].sort((left, right) => left - right).slice(-(MAX_HOURS + 2));
}

function rowsByHour(rows) {
  const result = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const hour = timestamp(row?.hourBucketMs ?? row?.hour_bucket_ms);
    if (hour !== null) result.set(hour, row);
  }
  return result;
}

function normalizeTotals(input = {}) {
  const tokens = {
    input: tokenValue(input, 'totalInputTokens', 'totalInputTokensKnownCount'),
    cacheCreation: tokenValue(
      input,
      'totalCacheCreationInputTokens',
      'totalCacheCreationInputTokensKnownCount',
    ),
    cacheRead: tokenValue(input, 'totalCacheReadInputTokens', 'totalCacheReadInputTokensKnownCount'),
    output: tokenValue(input, 'totalOutputTokens', 'totalOutputTokensKnownCount'),
  };
  return {
    tokens,
    knownTotal: input?.tokenTotalsOverflow === true ? null : safeSum(Object.values(tokens)),
    knownCounts: {
      input: integer(input?.totalInputTokensKnownCount),
      cacheCreation: integer(input?.totalCacheCreationInputTokensKnownCount),
      cacheRead: integer(input?.totalCacheReadInputTokensKnownCount),
      output: integer(input?.totalOutputTokensKnownCount),
    },
    coverage: {
      complete: integer(input?.usageCompleteCount),
      partial: integer(input?.usagePartialCount),
      unavailable: integer(input?.usageUnavailableCount),
      overflow: input?.tokenTotalsOverflow === true,
    },
  };
}

function hourlyPayload({ range, hourly, tokenHourly }) {
  const timestamps = bucketsFor(range, hourly, tokenHourly);
  const requests = rowsByHour(hourly);
  const tokens = rowsByHour(tokenHourly);
  const requestValue = (hour, field) => integer(requests.get(hour)?.[field]);
  const latencyValue = (hour, field) => duration(requests.get(hour)?.[field]);
  const tokenSeries = (valueField, knownField) => timestamps.map((hour) => [
    hour,
    tokenValue(tokens.get(hour), valueField, knownField),
  ]);
  return {
    timestamps,
    requests: {
      all: timestamps.map((hour) => requestValue(hour, 'requestCount')),
      success: timestamps.map((hour) => requestValue(hour, 'successCount')),
      error: timestamps.map((hour) => requestValue(hour, 'errorCount')),
    },
    latency: {
      ttfb: timestamps.map((hour) => [hour, latencyValue(hour, 'avgTtfbMs')]),
      duration: timestamps.map((hour) => [hour, latencyValue(hour, 'avgDurationMs')]),
    },
    tokens: {
      input: tokenSeries('totalInputTokens', 'totalInputTokensKnownCount'),
      cacheCreation: tokenSeries(
        'totalCacheCreationInputTokens',
        'totalCacheCreationInputTokensKnownCount',
      ),
      cacheRead: tokenSeries('totalCacheReadInputTokens', 'totalCacheReadInputTokensKnownCount'),
      output: tokenSeries('totalOutputTokens', 'totalOutputTokensKnownCount'),
    },
    coverage: timestamps.map((hour) => {
      const row = tokens.get(hour);
      return {
        complete: integer(row?.usageCompleteCount),
        partial: integer(row?.usagePartialCount),
        unavailable: integer(row?.usageUnavailableCount),
        overflow: row?.tokenTotalsOverflow === true,
      };
    }),
  };
}

function devicePayload(range, input = {}) {
  const devices = [];
  const seen = new Set();
  for (const source of Array.isArray(input.devices) ? input.devices : []) {
    const id = label(source?.value ?? source?.deviceId ?? source?.id);
    if (!id || seen.has(id) || devices.length >= MAX_DEVICES) continue;
    seen.add(id);
    devices.push({ id, label: label(source?.label ?? source?.name ?? id) || id });
  }
  const rows = (Array.isArray(input.rows) ? input.rows : []).filter((row) => (
    seen.has(label(row?.deviceId ?? row?.device_id ?? row?.device))
  ));
  const timestamps = bucketsFor(range, rows);
  const indexed = new Map();
  for (const row of rows) {
    const id = label(row?.deviceId ?? row?.device_id ?? row?.device);
    const hour = timestamp(row?.hourBucketMs ?? row?.hour_bucket_ms);
    if (id && hour !== null) indexed.set(`${id}\u0000${hour}`, row);
  }
  const buildSeries = (getter) => devices.map((device) => ({
    id: device.id,
    label: device.label,
    data: timestamps.map((hour) => [hour, getter(indexed.get(`${device.id}\u0000${hour}`))]),
  }));
  const inputSeries = buildSeries((row) => row ? deviceInput(row) : null);
  const outputSeries = buildSeries((row) => row ? deviceOutput(row) : null);
  const ranking = devices.map((device, index) => ({
    id: device.id,
    label: device.label,
    input: safeSum(inputSeries[index].data.map((point) => point[1])),
    output: safeSum(outputSeries[index].data.map((point) => point[1])),
  })).sort((left, right) => (
    (safeSum([right.input, right.output]) ?? -1) - (safeSum([left.input, left.output]) ?? -1)
      || left.label.localeCompare(right.label)
  ));
  return {
    timestamps,
    input: inputSeries,
    output: outputSeries,
    ranking,
    truncation: {
      devices: input.devicesTruncated === true
        || (Array.isArray(input.devices) && input.devices.length > MAX_DEVICES),
      hours: input.hoursTruncated === true,
      unavailableDeviceCount: integer(input.unavailableDeviceCount),
    },
  };
}

function breakdownPayload(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const totals = normalizeTotals(row);
    return {
      label: label(row?.label ?? row?.groupLabel ?? row?.groupValue) || '—',
      value: totals.knownTotal,
      lowerBound: totals.coverage.partial > 0 || totals.coverage.unavailable > 0,
    };
  }).filter((row) => row.value !== null)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, MAX_BREAKDOWN_ROWS);
}

export function buildMetricsChartPayload({
  range = {},
  totals = {},
  tokenTotals = {},
  hourly = [],
  tokenHourly = [],
  deviceTokenComparison = {},
  accountTokenBreakdown = [],
  modelTokenBreakdown = [],
  metricsAvailable = true,
  droppedMetrics = 0,
} = {}) {
  const normalizedRange = {
    fromMs: timestamp(range.fromMs),
    toMs: timestamp(range.toMs),
    hours: integer(range.hours),
    timezone: 'UTC',
  };
  return {
    version: 1,
    range: normalizedRange,
    available: metricsAvailable === true,
    droppedMetrics: integer(droppedMetrics),
    totals: {
      requests: {
        all: integer(totals.all),
        consumption: integer(totals.consumption),
      },
      ...normalizeTotals(tokenTotals),
    },
    hourly: hourlyPayload({ range: normalizedRange, hourly, tokenHourly }),
    devices: devicePayload(normalizedRange, deviceTokenComparison),
    breakdowns: {
      accounts: breakdownPayload(accountTokenBreakdown),
      models: breakdownPayload(modelTokenBreakdown),
    },
  };
}
