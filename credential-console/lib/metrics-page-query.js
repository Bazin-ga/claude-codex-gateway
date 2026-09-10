const EMPTY_DEVICE_COMPARISON = Object.freeze({
  devices: [],
  rows: [],
  truncated: false,
  devicesTruncated: false,
  hoursTruncated: false,
  unavailableDeviceCount: 0,
});

/**
 * Run the database-only half of one metrics page. Keeping this projection free
 * of CredentialStore objects makes it structured-cloneable and lets production
 * execute it in a worker without moving credentials or device tokens across the
 * thread boundary.
 */
export function queryMetricsDataset(requestMetrics, filters) {
  const { fromMs, toMs, memberLabel, accountId, model } = filters;
  const allTotals = requestMetrics.queryTotals({ ...filters, scope: 'all' });
  const consumptionTotals = requestMetrics.queryTotals({ ...filters, scope: 'consumption' });
  const hourly = requestMetrics.queryHourly({ ...filters, scope: 'all' });
  const tokenHourly = requestMetrics.queryHourly({ ...filters, scope: 'consumption' });
  const dimensions = { fromMs, toMs, scope: 'all' };
  const machineRows = requestMetrics.queryBreakdown({ by: 'machine', ...dimensions });
  const deviceRows = requestMetrics.queryBreakdown({ by: 'device', ...dimensions });
  const memberRows = requestMetrics.queryBreakdown({ by: 'member', ...dimensions });
  const accountRows = requestMetrics.queryBreakdown({ by: 'account', ...dimensions });
  const modelRows = requestMetrics.queryBreakdown({ by: 'model', ...dimensions });
  const tokenBreakdown = typeof requestMetrics.queryTokenBreakdown === 'function'
    ? requestMetrics.queryTokenBreakdown.bind(requestMetrics)
    : requestMetrics.queryBreakdown.bind(requestMetrics);
  const accountTokenBreakdown = tokenBreakdown({
    by: 'account',
    ...filters,
    scope: 'consumption',
  });
  const modelTokenBreakdown = tokenBreakdown({
    by: 'model',
    ...filters,
    scope: 'consumption',
  });
  let deviceTokenComparison = EMPTY_DEVICE_COMPARISON;
  let deviceComparisonError = null;
  if (typeof requestMetrics.queryDeviceTokenHourly === 'function') {
    try {
      deviceTokenComparison = requestMetrics.queryDeviceTokenHourly({
        fromMs,
        toMs,
        ...(memberLabel ? { memberLabel } : {}),
        ...(accountId ? { accountId } : {}),
        ...(model ? { model } : {}),
      });
    } catch (error) {
      deviceComparisonError = error?.code ?? error?.name ?? 'unknown';
    }
  }
  return {
    allTotals,
    consumptionTotals,
    hourly,
    tokenHourly,
    machineRows,
    deviceRows,
    memberRows,
    accountRows,
    modelRows,
    accountTokenBreakdown,
    modelTokenBreakdown,
    deviceTokenComparison,
    deviceComparisonError,
  };
}
