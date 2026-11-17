import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import {
  AriaComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  AriaComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  SVGRenderer,
]);

/**
 * Bind the dashboard to whatever is in the document now.
 *
 * Navigation re-renders the page inside the existing document, so this can no
 * longer be a one-shot at load: arriving at /metrics from another tab has to
 * bind to DOM that did not exist when this module first ran.
 */
/**
 * Undo the previous binding.
 *
 * Navigation replaces the dashboard without ever unloading the document, so
 * `pagehide` — which used to be the only cleanup — never fires. Without this,
 * every visit to /metrics left its chart instances and observers alive against
 * detached nodes: measured at ~1.4 MB per visit, monotonic across a forced GC,
 * and eventually slow enough to look like a hang.
 */
let teardownMetricsDashboard = null;

function bootMetricsDashboard() {
  const dashboard = document.querySelector('[data-metrics-dashboard]');
  if (!dashboard) {
    // Left the page entirely: release the previous dashboard.
    teardownMetricsDashboard?.();
    teardownMetricsDashboard = null;
    return;
  }
  if (dashboard.dataset.metricsBound === 'true') return;
  teardownMetricsDashboard?.();
  teardownMetricsDashboard = null;
  dashboard.dataset.metricsBound = 'true';
  {
  const colors = Object.freeze({
    input: '#0072b2',
    cacheCreation: '#e69f00',
    cacheRead: '#009e73',
    output: '#cc79a7',
    total: '#33413c',
    success: '#009e73',
    error: '#d55e00',
    ttfb: '#e69f00',
    duration: '#0072b2',
  });
  const deviceColors = Object.freeze([
    '#0072b2', '#e69f00', '#009e73', '#cc79a7',
    '#d55e00', '#56b4e9', '#7b61a8', '#6b756f',
  ]);
  const copy = Object.freeze({
    en: {
      input: 'Input',
      cacheCreation: 'Cache creation',
      cacheRead: 'Cache read',
      output: 'Output',
      totalRequests: 'All requests',
      successfulRequests: 'Successful',
      errorRequests: 'Errors',
      ttfb: 'Average TTFB',
      duration: 'Average duration',
      knownTokens: 'Known tokens',
      inputSide: 'Input-side known tokens',
      noData: 'No matching data for this period',
      tokens: 'tokens',
      requests: 'requests',
      milliseconds: 'ms',
      unknown: 'unknown',
      account: 'Account',
      model: 'Model',
    },
    zh: {
      input: '输入',
      cacheCreation: '缓存创建',
      cacheRead: '缓存读取',
      output: '输出',
      totalRequests: '全部请求',
      successfulRequests: '成功',
      errorRequests: '错误',
      ttfb: '平均首字节时间',
      duration: '平均总耗时',
      knownTokens: '已知 Token',
      inputSide: '输入侧已知 Token',
      noData: '当前时间范围没有匹配数据',
      tokens: 'Token',
      requests: '次请求',
      milliseconds: '毫秒',
      unknown: '未知',
      account: '账号',
      model: '模型',
    },
  });
  const compactNumber = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const exactNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const instances = new Map();
  const observers = [];
  const deviceMetricStateKey = `credential_console_device_metric:${location.pathname}${location.search}`;
  let payload = null;
  let deviceMetric = (() => {
    try {
      return sessionStorage.getItem(deviceMetricStateKey) === 'output' ? 'output' : 'input';
    } catch {
      return 'input';
    }
  })();

  function language() {
    return document.documentElement.lang === 'zh-CN' ? 'zh' : 'en';
  }

  function words() {
    return copy[language()];
  }

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function hasKnown(values) {
    return Array.isArray(values) && values.some((entry) => finite(entry?.[1]) !== null);
  }

  function hourLabel(value, short = false) {
    const numeric = finite(value);
    if (numeric === null) return '—';
    const date = new Date(numeric);
    if (!Number.isFinite(date.getTime())) return '—';
    // In the zone picked in the page header; UTC only if the page script is missing.
    const time = window.credentialConsoleTime;
    if (time) {
      try {
        return time.format(numeric, { bare: short });
      } catch {
        // Fall back to UTC below.
      }
    }
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    return short ? `${month}-${day} ${hour}:00` : `${date.getUTCFullYear()}-${month}-${day} ${hour}:00 UTC`;
  }

  function valueLabel(value, unit) {
    const numeric = finite(value);
    return numeric === null ? words().unknown : `${exactNumber.format(numeric)} ${unit}`;
  }

  function zoomStateKey(kind) {
    return `credential_console_chart_zoom:${kind}:${location.pathname}${location.search}`;
  }

  function storedZoom(kind, fallbackStart) {
    try {
      const value = JSON.parse(sessionStorage.getItem(zoomStateKey(kind)) ?? 'null');
      if (Number.isFinite(value?.start) && Number.isFinite(value?.end)
        && value.start >= 0 && value.end <= 100 && value.start < value.end) return value;
    } catch {
      // Use the bounded default window.
    }
    return { start: fallbackStart, end: 100 };
  }

  function visibleZoom(pointCount, kind) {
    if (pointCount <= 48) return [];
    const initial = storedZoom(kind, Math.max(0, 100 - (48 / pointCount) * 100));
    return [
      { type: 'inside', filterMode: 'none', start: initial.start, end: initial.end, zoomOnMouseWheel: 'shift' },
      {
        type: 'slider',
        filterMode: 'none',
        start: initial.start,
        end: initial.end,
        height: 16,
        bottom: 4,
        borderColor: '#d9dfd7',
        backgroundColor: '#f3f5ef',
        fillerColor: 'rgba(0,114,178,.12)',
        handleStyle: { color: '#0072b2' },
        textStyle: { color: '#60706a', fontSize: 10 },
      },
    ];
  }

  function commonOption({ points = 0, legend = true, unit = words().tokens, kind = 'chart' } = {}) {
    const zoom = visibleZoom(points, kind);
    return {
      animation: !reduceMotion,
      animationDuration: 280,
      color: [colors.input, colors.cacheCreation, colors.cacheRead, colors.output],
      textStyle: {
        color: '#16211d',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      },
      aria: { enabled: true, decal: { show: true } },
      tooltip: {
        trigger: 'axis',
        renderMode: 'richText',
        confine: true,
        axisPointer: { type: 'cross', snap: false },
        valueFormatter: (value) => valueLabel(value, unit),
      },
      legend: legend ? {
        type: 'scroll',
        bottom: zoom.length ? 29 : 2,
        left: 8,
        right: 8,
        itemWidth: 16,
        itemHeight: 8,
        textStyle: { color: '#60706a', fontSize: 11, overflow: 'truncate', width: 150 },
      } : undefined,
      grid: {
        top: 18,
        right: 18,
        bottom: zoom.length ? 74 : (legend ? 42 : 30),
        left: 16,
        containLabel: true,
      },
      dataZoom: zoom,
      xAxis: {
        type: 'time',
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#cbd4cb' } },
        axisTick: { show: false },
        axisLabel: { color: '#60706a', hideOverlap: true, formatter: (value) => hourLabel(value, true) },
        // The tooltip heading reads this too; left alone it shows browser time.
        axisPointer: { label: { formatter: ({ value }) => hourLabel(value) } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        axisLabel: { color: '#60706a', formatter: (value) => compactNumber.format(value) },
        splitLine: { lineStyle: { color: '#e4e9e3' } },
      },
    };
  }

  function emptyOption() {
    return {
      animation: false,
      aria: { enabled: true },
      xAxis: { show: false },
      yAxis: { show: false },
      graphic: [{
        type: 'text',
        left: 'center',
        top: 'middle',
        style: { text: words().noData, fill: '#60706a', fontSize: 13 },
      }],
      series: [],
    };
  }

  function tokenOption() {
    const hourly = payload?.hourly;
    if (!hourly || !Object.values(hourly.tokens ?? {}).some(hasKnown)) return emptyOption();
    const option = commonOption({ points: hourly.timestamps.length, kind: 'tokens' });
    option.xAxis.boundaryGap = true;
    option.series = [
      ['input', words().input, colors.input],
      ['cacheCreation', words().cacheCreation, colors.cacheCreation],
      ['cacheRead', words().cacheRead, colors.cacheRead],
      ['output', words().output, colors.output],
    ].map(([key, name, color]) => ({
      name,
      type: 'bar',
      stack: 'known-tokens',
      barMaxWidth: 34,
      itemStyle: { color, borderRadius: key === 'output' ? [4, 4, 0, 0] : 0 },
      emphasis: { focus: 'series' },
      data: hourly.tokens[key],
    }));
    return option;
  }

  function requestsOption() {
    const hourly = payload?.hourly;
    if (!hourly || !hasKnown(hourly.requests?.all?.map((value, index) => [hourly.timestamps[index], value]))) {
      return emptyOption();
    }
    const option = commonOption({ points: hourly.timestamps.length, unit: words().requests, kind: 'requests' });
    option.xAxis.boundaryGap = true;
    option.color = [colors.total, colors.success, colors.error];
    option.series = [
      {
        name: words().totalRequests,
        type: 'line',
        data: hourly.timestamps.map((timestamp, index) => [timestamp, hourly.requests.all[index]]),
        showSymbol: hourly.timestamps.length <= 36,
        symbolSize: 6,
        lineStyle: { width: 2.5, color: colors.total },
        itemStyle: { color: colors.total },
        connectNulls: false,
        z: 3,
      },
      {
        name: words().successfulRequests,
        type: 'bar',
        stack: 'outcomes',
        data: hourly.timestamps.map((timestamp, index) => [timestamp, hourly.requests.success[index]]),
        itemStyle: { color: colors.success },
        barMaxWidth: 28,
      },
      {
        name: words().errorRequests,
        type: 'bar',
        stack: 'outcomes',
        data: hourly.timestamps.map((timestamp, index) => [timestamp, hourly.requests.error[index]]),
        itemStyle: { color: colors.error },
        barMaxWidth: 28,
      },
    ];
    return option;
  }

  function latencyOption() {
    const hourly = payload?.hourly;
    if (!hourly || (!hasKnown(hourly.latency?.ttfb) && !hasKnown(hourly.latency?.duration))) return emptyOption();
    const option = commonOption({ points: hourly.timestamps.length, unit: words().milliseconds, kind: 'latency' });
    option.color = [colors.ttfb, colors.duration];
    option.series = [
      ['ttfb', words().ttfb, colors.ttfb],
      ['duration', words().duration, colors.duration],
    ].map(([key, name, color]) => ({
      name,
      type: 'line',
      data: hourly.latency[key],
      showSymbol: hourly.timestamps.length <= 36,
      symbolSize: 6,
      connectNulls: false,
      lineStyle: { width: 2.5, color },
      itemStyle: { color },
      emphasis: { focus: 'series' },
    }));
    return option;
  }

  function horizontalBars(rows, dimension) {
    if (!Array.isArray(rows) || !rows.some((row) => finite(row.value) !== null)) return emptyOption();
    const ordered = [...rows].filter((row) => finite(row.value) !== null).slice(0, 8).reverse();
    return {
      animation: !reduceMotion,
      animationDuration: 280,
      color: [dimension === 'account' ? colors.input : colors.output],
      textStyle: { color: '#16211d', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
      aria: { enabled: true, decal: { show: true } },
      tooltip: {
        trigger: 'item',
        renderMode: 'richText',
        confine: true,
        valueFormatter: (value) => valueLabel(value, words().tokens),
      },
      grid: { top: 8, right: 18, bottom: 26, left: 12, containLabel: true },
      xAxis: {
        type: 'value',
        min: 0,
        axisLabel: { color: '#60706a', formatter: (value) => compactNumber.format(value) },
        splitLine: { lineStyle: { color: '#e4e9e3' } },
      },
      yAxis: {
        type: 'category',
        data: ordered.map((row) => row.label),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: {
          color: '#33413c',
          width: 150,
          overflow: 'truncate',
          formatter: (value) => value.length > 24 ? `${value.slice(0, 23)}…` : value,
        },
      },
      series: [{
        name: dimension === 'account' ? words().account : words().model,
        type: 'bar',
        data: ordered.map((row) => row.value),
        barMaxWidth: 26,
        itemStyle: { borderRadius: [0, 6, 6, 0] },
        label: {
          show: true,
          position: 'right',
          color: '#60706a',
          formatter: ({ value }) => compactNumber.format(value),
        },
      }],
    };
  }

  function breakdownOption(kind) {
    return horizontalBars(payload?.breakdowns?.[kind] ?? [], kind === 'accounts' ? 'account' : 'model');
  }

  function deviceRankingOption() {
    const ranking = payload?.devices?.ranking ?? [];
    if (!ranking.some((row) => finite(row.input) !== null || finite(row.output) !== null)) return emptyOption();
    const rows = ranking.slice(0, 8).reverse();
    return {
      animation: !reduceMotion,
      animationDuration: 280,
      color: [colors.input, colors.output],
      textStyle: { color: '#16211d', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
      aria: { enabled: true, decal: { show: true } },
      tooltip: {
        trigger: 'axis',
        renderMode: 'richText',
        confine: true,
        axisPointer: { type: 'shadow' },
        valueFormatter: (value) => valueLabel(value, words().tokens),
      },
      legend: {
        type: 'scroll',
        bottom: 0,
        textStyle: { color: '#60706a', fontSize: 11 },
      },
      grid: { top: 10, right: 18, bottom: 42, left: 12, containLabel: true },
      xAxis: {
        type: 'value', min: 0,
        axisLabel: { color: '#60706a', formatter: (value) => compactNumber.format(value) },
        splitLine: { lineStyle: { color: '#e4e9e3' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((row) => row.label),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: '#33413c', width: 145, overflow: 'truncate' },
      },
      series: [
        {
          name: words().inputSide,
          type: 'bar',
          stack: 'device-total',
          data: rows.map((row) => row.input),
          itemStyle: { color: colors.input },
          barMaxWidth: 27,
        },
        {
          name: words().output,
          type: 'bar',
          stack: 'device-total',
          data: rows.map((row) => row.output),
          itemStyle: { color: colors.output, borderRadius: [0, 6, 6, 0] },
          barMaxWidth: 27,
        },
      ],
    };
  }

  function deviceTrendOption() {
    const devices = payload?.devices;
    const series = deviceMetric === 'output' ? devices?.output : devices?.input;
    if (!devices || !Array.isArray(series) || !series.some((row) => hasKnown(row.data))) return emptyOption();
    const option = commonOption({ points: devices.timestamps?.length ?? 0, kind: 'device-trend' });
    option.color = deviceColors;
    option.series = series.map((row, index) => ({
      name: row.label,
      type: 'line',
      data: row.data,
      showSymbol: (devices.timestamps?.length ?? 0) <= 36,
      symbolSize: 6,
      connectNulls: false,
      lineStyle: {
        width: 2.4,
        color: deviceColors[index % deviceColors.length],
        type: index % 3 === 1 ? 'dashed' : index % 3 === 2 ? 'dotted' : 'solid',
      },
      itemStyle: { color: deviceColors[index % deviceColors.length] },
      emphasis: { focus: 'series' },
    }));
    return option;
  }

  function optionFor(kind) {
    if (kind === 'tokens') return tokenOption();
    if (kind === 'requests') return requestsOption();
    if (kind === 'latency') return latencyOption();
    if (kind === 'accounts') return breakdownOption('accounts');
    if (kind === 'models') return breakdownOption('models');
    if (kind === 'device-ranking') return deviceRankingOption();
    if (kind === 'device-trend') return deviceTrendOption();
    return emptyOption();
  }

  function markReady(host) {
    host.hidden = false;
    host.closest('.metrics-chart-panel')?.classList.add('metrics-echarts-ready');
  }

  function renderHost(host) {
    const kind = host.dataset.metricsChart;
    if (!kind) return;
    let chart = instances.get(host);
    if (!chart) {
      const wasHidden = host.hidden;
      host.hidden = false;
      try {
        chart = echarts.init(host, null, { renderer: 'svg' });
      } catch (error) {
        host.hidden = wasHidden;
        throw error;
      }
      instances.set(host, chart);
      chart.on('datazoom', (event) => {
        const state = event?.batch?.[0] ?? event;
        if (!Number.isFinite(state?.start) || !Number.isFinite(state?.end)) return;
        try {
          sessionStorage.setItem(zoomStateKey(kind), JSON.stringify({ start: state.start, end: state.end }));
        } catch {
          // Zoom persistence is optional.
        }
      });
      if ('ResizeObserver' in window) {
        let scheduled = false;
        const observer = new ResizeObserver(() => {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(() => {
            scheduled = false;
            if (!chart.isDisposed()) chart.resize();
          });
        });
        observer.observe(host);
        observers.push(observer);
      }
    }
    const option = optionFor(kind);
    const panel = host.closest('.metrics-chart-panel');
    panel?.classList.toggle('metrics-chart-empty', !Array.isArray(option.series) || option.series.length === 0);
    chart.setOption(option, { notMerge: true, lazyUpdate: false });
    markReady(host);
  }

  function renderAll() {
    document.querySelectorAll('[data-metrics-chart]').forEach(renderHost);
    document.querySelectorAll('[data-device-metric]').forEach((button) => {
      const active = button.dataset.deviceMetric === deviceMetric;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  async function load() {
    const endpoint = dashboard.dataset.metricsEndpoint;
    if (!endpoint) return;
    dashboard.dataset.echartsState = 'loading';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(endpoint, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`metrics data returned ${response.status}`);
      const next = await response.json();
      if (!next || next.version !== 1 || next.available !== true) {
        throw new Error('metrics data contract unavailable');
      }
      payload = next;
      renderAll();
      dashboard.dataset.echartsState = 'ready';
    } catch {
      dashboard.dataset.echartsState = 'fallback';
    } finally {
      clearTimeout(timer);
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-device-metric]');
    if (!button || !payload) return;
    deviceMetric = button.dataset.deviceMetric === 'output' ? 'output' : 'input';
    try {
      sessionStorage.setItem(deviceMetricStateKey, deviceMetric);
    } catch {
      // This preference is optional; charts still work without storage.
    }
    const host = document.querySelector('[data-metrics-chart="device-trend"]');
    if (host) renderHost(host);
    document.querySelectorAll('[data-device-metric]').forEach((candidate) => {
      const active = candidate.dataset.deviceMetric === deviceMetric;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  });

  window.addEventListener('credential-console-language', () => {
    if (payload) renderAll();
  });

  const onTimeZone = () => {
    if (payload) renderAll();
  };
  window.addEventListener('credential-console-time-zone', onTimeZone);

  const releaseDashboard = () => {
    window.removeEventListener('credential-console-time-zone', onTimeZone);
    observers.splice(0).forEach((observer) => observer.disconnect());
    for (const chart of instances.values()) {
      if (!chart.isDisposed()) chart.dispose();
    }
    instances.clear();
    // A torn-down dashboard must stop claiming to be bound, or a node that
    // comes back into the document would be skipped and render nothing.
    delete dashboard.dataset.metricsBound;
  };
  teardownMetricsDashboard = releaseDashboard;
  window.addEventListener('pagehide', releaseDashboard, { once: true });

  load();
  }
}

bootMetricsDashboard();
// Arriving at /metrics without a document load.
window.addEventListener('credential-console-navigated', () => {
  // Two frames: one for the swapped nodes to be laid out, one for the styles
  // that size them. Initialising before that gives ECharts a near-zero width
  // and it renders every axis label on top of itself.
  requestAnimationFrame(() => requestAnimationFrame(bootMetricsDashboard));
});

/**
 * The third-party page's month by source: a stacked bar per day (cost, tokens
 * or requests), what the free source saved (per day and running total), and
 * the day-by-day table. The page carries the month by hour; days are cut
 * here in the zone picked in the page header.
 */
let teardownRelayCharts = null;

function bootRelayCharts() {
  const card = document.querySelector('#relay-usage');
  const holder = card?.querySelector('[data-relay-usage-data]');
  if (!card || !holder) {
    teardownRelayCharts?.();
    teardownRelayCharts = null;
    return;
  }
  if (card.dataset.relayBound === 'true') return;
  teardownRelayCharts?.();
  card.dataset.relayBound = 'true';
  let data;
  try {
    data = JSON.parse(holder.textContent);
  } catch {
    return;
  }
  const palette = ['#2f7d5b', '#c98a2b', '#4d6bb3', '#a04a62', '#6f8f2a', '#7a7a7a'];
  const t = (key, english) => window.credentialConsoleText?.text(key, english) ?? english;
  const usageHost = card.querySelector('[data-relay-usage-chart]');
  const savedHost = card.querySelector('[data-relay-saved-chart]');
  const charts = [];
  let metric = 'cost';

  const dayOf = (ms) => {
    const time = window.credentialConsoleTime;
    if (time) {
      try {
        return time.format(ms, { date: true });
      } catch {
        // UTC below.
      }
    }
    return new Date(ms).toISOString().slice(0, 10);
  };
  const compact = (value, kind) => {
    if (!Number.isFinite(value)) return '—';
    if (kind === 'cost') {
      if (value >= 1000) return `$${Math.round(value).toLocaleString('en-US')}`;
      return `$${value >= 100 ? value.toFixed(0) : value.toFixed(2)}`;
    }
    const short = (amount, unit) => `${Number(amount.toFixed(1))}${unit}`;
    if (value >= 1e9) return short(value / 1e9, 'B');
    if (value >= 1e6) return short(value / 1e6, 'M');
    if (value >= 1e3) return short(value / 1e3, 'K');
    return String(Math.round(value));
  };
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Everything that depends on the time zone, recomputed when it changes.
  const tally = () => {
    const days = [];
    const index = new Map();
    for (let ms = Math.floor(data.from / 3_600_000) * 3_600_000; ms <= data.to; ms += 3_600_000) {
      const key = dayOf(ms);
      if (!index.has(key)) {
        index.set(key, days.length);
        days.push(key);
      }
    }
    const blank = () => days.map(() => 0);
    const per = data.sources.map(() => ({ cost: blank(), tokens: blank(), requests: blank(), failures: blank(), saved: blank() }));
    for (const [at, source, requests, failures, input, cached, output, cost, saved] of data.hours) {
      const day = index.get(dayOf(at));
      const bucket = per[source];
      if (day === undefined || !bucket) continue;
      bucket.requests[day] += requests;
      bucket.failures[day] += failures;
      bucket.tokens[day] += input + cached + output;
      bucket.cost[day] += cost || 0;
      bucket.saved[day] += saved || 0;
    }
    return { days, per };
  };

  const chartFor = (host) => {
    host.hidden = false;
    let chart = echarts.getInstanceByDom(host);
    if (!chart) {
      chart = echarts.init(host, null, { renderer: 'svg' });
      charts.push(chart);
    }
    return chart;
  };
  // Axis ticks are round numbers: no trailing ".00".
  const axisLabel = (kind) => ({
    formatter: (value) => (kind === 'cost' ? `$${Number(value.toFixed(2)).toLocaleString('en-US')}` : compact(value, kind)),
    color: '#66736c',
  });
  const dayLabel = (key) => key.slice(5);

  const render = () => {
    const { days, per } = tally();
    const used = data.sources.map((source, index) => ({ ...source, index, color: palette[index % palette.length] }))
      .filter((source) => per[source.index].requests.some((value) => value > 0));

    // Stacked bars by source.
    const series = used.map((source) => ({
      name: source.name,
      type: 'bar',
      stack: 'sources',
      barMaxWidth: 28,
      itemStyle: { color: source.color },
      emphasis: { focus: 'series' },
      data: per[source.index][metric],
    }));
    chartFor(usageHost).setOption({
      animation: false,
      grid: { left: 64, right: 18, top: 36, bottom: 30 },
      legend: { top: 0, data: used.map((source) => source.name) },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (items) => {
          const day = days[items[0]?.dataIndex] ?? '';
          const total = items.reduce((sum, item) => sum + (item.value || 0), 0);
          return `${escape(day)}<br>${items.filter((item) => item.value).map((item) => `${item.marker}${escape(item.seriesName)}: <b>${compact(item.value, metric)}</b>`).join('<br>')}<br>${escape(t('relay-usage-total', 'Total'))}: <b>${compact(total, metric)}</b>`;
        },
      },
      xAxis: { type: 'category', data: days.map(dayLabel), axisLabel: { color: '#66736c' } },
      yAxis: { type: 'value', axisLabel: axisLabel(metric === 'cost' ? 'cost' : 'count'), splitLine: { lineStyle: { color: '#e3e8e3' } } },
      series,
    }, { replaceMerge: ['series'] });
    card.querySelectorAll('[data-relay-usage-metric] button').forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.metric === metric ? 'true' : 'false');
    });

    // What the free source saved: bars per day, the running total as a line.
    const free = data.sources.map((source, index) => ({ source, index })).filter(({ source }) => source.free);
    const savedDaily = days.map((_, day) => free.reduce((sum, { index }) => sum + per[index].saved[day], 0));
    let running = 0;
    const cumulative = savedDaily.map((value) => (running += value));
    const totalBox = card.querySelector('[data-relay-saved-total]');
    if (free.length) {
      const requests = free.reduce((sum, { index }) => sum + per[index].requests.reduce((a, b) => a + b, 0), 0);
      const tokens = free.reduce((sum, { index }) => sum + per[index].tokens.reduce((a, b) => a + b, 0), 0);
      const reference = free.find(({ source }) => source.reference)?.source.reference ?? '—';
      totalBox.innerHTML = `${escape(t('relay-saved-total', 'Saved over these 30 days'))}: <strong>${compact(running, 'cost')}</strong> <span class="muted tiny">(${escape(free.map(({ source }) => source.name).join(', '))} · ${requests.toLocaleString('en-US')} ${escape(t('relay-requests', 'Requests'))} · ${compact(tokens, 'count')} tokens · ${escape(t('relay-tile-saved-at', 'at the price of'))} ${escape(reference)})</span>`;
      chartFor(savedHost).setOption({
        animation: false,
        grid: { left: 64, right: 64, top: 36, bottom: 30 },
        legend: { top: 0 },
        tooltip: {
          trigger: 'axis',
          formatter: (items) => `${escape(days[items[0]?.dataIndex] ?? '')}<br>${items.map((item) => `${item.marker}${escape(item.seriesName)}: <b>${compact(item.value, 'cost')}</b>`).join('<br>')}`,
        },
        xAxis: { type: 'category', data: days.map(dayLabel), axisLabel: { color: '#66736c' } },
        yAxis: [
          { type: 'value', axisLabel: axisLabel('cost'), splitLine: { lineStyle: { color: '#e3e8e3' } } },
          { type: 'value', axisLabel: { ...axisLabel('cost'), color: '#c98a2b' }, splitLine: { show: false } },
        ],
        series: [
          { name: t('relay-saved-daily', 'Saved that day'), type: 'bar', barMaxWidth: 28, itemStyle: { color: '#2f7d5b' }, data: savedDaily },
          { name: t('relay-saved-running', 'Running total'), type: 'line', yAxisIndex: 1, symbolSize: 5, itemStyle: { color: '#c98a2b' }, lineStyle: { width: 2 }, data: cumulative },
        ],
      }, { replaceMerge: ['series'] });
    } else {
      totalBox.textContent = t('relay-saved-none', 'No source in a chain costs nothing.');
      savedHost.hidden = true;
    }

    // Day by day, newest first.
    const head = used.map((source) => `<th>${escape(source.name)}</th>`).join('');
    const rows = days.map((day, index) => ({ day, index })).reverse().map(({ day, index }) => `<tr><td>${escape(day)}</td>${used.map((source) => {
      const requests = per[source.index].requests[index];
      if (!requests) return '<td class="muted">—</td>';
      const failures = per[source.index].failures[index];
      const money = source.free ? per[source.index].saved[index] : per[source.index].cost[index];
      return `<td>${requests.toLocaleString('en-US')}<div class="muted tiny">${((failures / requests) * 100).toFixed(1)}% · ${source.free ? '−' : ''}${compact(money, 'cost')}</div></td>`;
    }).join('')}</tr>`).join('');
    card.querySelector('[data-relay-usage-table]').innerHTML = `<table><thead><tr><th>${escape(t('relay-usage-day', 'Day'))}</th>${head}</tr></thead><tbody>${rows}</tbody></table>
      <p class="muted tiny">${escape(t('relay-usage-cell', 'Each cell: requests, then failure rate and estimated cost (for a free source, − what it saved).'))}</p>`;
    const fallback = card.querySelector('[data-relay-usage-fallback]');
    if (fallback) fallback.hidden = true;
  };

  const metrics = card.querySelector('[data-relay-usage-metric]');
  metrics.hidden = false;
  const onMetric = (event) => {
    const button = event.target.closest('button[data-metric]');
    if (!button) return;
    metric = button.dataset.metric;
    render();
  };
  metrics.addEventListener('click', onMetric);
  window.addEventListener('credential-console-language', render);
  window.addEventListener('credential-console-time-zone', render);
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => charts.forEach((chart) => chart.resize()))
    : null;
  observer?.observe(card);
  render();

  teardownRelayCharts = () => {
    metrics.removeEventListener('click', onMetric);
    window.removeEventListener('credential-console-language', render);
    window.removeEventListener('credential-console-time-zone', render);
    observer?.disconnect();
    charts.splice(0).forEach((chart) => { if (!chart.isDisposed()) chart.dispose(); });
    delete card.dataset.relayBound;
  };
  window.addEventListener('pagehide', () => teardownRelayCharts?.(), { once: true });
}

bootRelayCharts();
window.addEventListener('credential-console-navigated', () => {
  requestAnimationFrame(() => requestAnimationFrame(bootRelayCharts));
});
