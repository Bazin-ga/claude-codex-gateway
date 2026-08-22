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
function bootMetricsDashboard() {
  const dashboard = document.querySelector('[data-metrics-dashboard]');
  if (!dashboard) return;
  if (dashboard.dataset.metricsBound === 'true') return;
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

  window.addEventListener('pagehide', () => {
    observers.splice(0).forEach((observer) => observer.disconnect());
    for (const chart of instances.values()) {
      if (!chart.isDisposed()) chart.dispose();
    }
    instances.clear();
  }, { once: true });

  load();
  }
}

bootMetricsDashboard();
// Arriving at /metrics without a document load.
window.addEventListener('credential-console-navigated', bootMetricsDashboard);
