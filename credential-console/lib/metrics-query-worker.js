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

if (store) {
  parentPort.on('message', (message) => {
    if (message?.type === 'close') {
      store.close();
      parentPort.close();
      return;
    }
    if (message?.type !== 'query' || !Number.isSafeInteger(message.id)) return;
    try {
      parentPort.postMessage({
        type: 'result',
        id: message.id,
        dataset: queryMetricsDataset(store, message.filters ?? {}),
      });
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
