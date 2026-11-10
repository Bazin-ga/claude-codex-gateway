import { parentPort, workerData } from 'node:worker_threads';
import { MetricsStore } from './metrics.js';
import { queryMetricsDataset } from './metrics-page-query.js';

if (!parentPort) throw new Error('metrics query worker requires a parent port');

let store;
try {
  store = await new MetricsStore({ dbPath: workerData.dbPath, readOnly: true }).init();
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({
    type: 'fatal',
    error: {
      name: error?.name ?? 'Error',
      code: error?.code ?? null,
      message: error?.message ?? 'metrics query worker initialization failed',
    },
  });
  parentPort.close();
}

const QUERIES = new Map([
  ['query', (message) => queryMetricsDataset(store, message.filters ?? {})],
  ['api-spend', (message) => store.queryApiSpendGroups(message.params ?? {})],
  ['relay-stats', (message) => store.queryRelayStats(message.params ?? {})],
]);

if (store) {
  parentPort.on('message', (message) => {
    if (message?.type === 'close') {
      store.close();
      parentPort.close();
      return;
    }
    const run = QUERIES.get(message?.type);
    if (!run || !Number.isSafeInteger(message.id)) return;
    try {
      parentPort.postMessage({ type: 'result', id: message.id, dataset: run(message) });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        id: message.id,
        error: {
          name: error?.name ?? 'Error',
          code: error?.code ?? null,
          message: error?.message ?? 'metrics query failed',
        },
      });
    }
  });
}
