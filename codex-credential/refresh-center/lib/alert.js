/**
 * Alerting for the refresh chain.
 *
 * This is not decoration. A broken refresh chain is invisible: clients keep
 * working on the access tokens they already hold and only start failing when
 * those expire — days later, all at once, far from the cause. So a refresh
 * failure has to reach a human while there is still slack to fix it.
 *
 * Alerts always go to stderr. A webhook is additionally used when configured,
 * and a webhook that itself fails must never mask the original alert.
 */

const WEBHOOK_TIMEOUT_MS = 10_000;

/** @typedef {'info' | 'warn' | 'critical'} Severity */

export class Alerter {
  /**
   * @param {object} [options]
   * @param {string} [options.webhookUrl] POST target receiving `{severity, message, detail, host, at}`.
   * @param {string} [options.host] Identifies which deployment is speaking.
   * @param {typeof fetch} [options.fetchImpl] Injectable for tests.
   */
  constructor({ webhookUrl, host, fetchImpl = fetch } = {}) {
    this.webhookUrl = webhookUrl;
    this.host = host ?? 'unknown-host';
    this.fetch = fetchImpl;
  }

  /** @param {Severity} severity */
  async send(severity, message, detail = {}) {
    const at = new Date().toISOString();
    const line = `[${at}] ${severity.toUpperCase()} ${message}`;
    const rendered = Object.keys(detail).length ? `${line} ${JSON.stringify(detail)}` : line;

    if (severity === 'info') console.log(rendered);
    else console.error(rendered);

    if (!this.webhookUrl) return true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await this.fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ severity, message, detail, host: this.host, at }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`webhook returned HTTP ${response.status}`);
      }
      return true;
    } catch (err) {
      // Report the delivery failure, but never let it replace or suppress the
      // alert above — stderr already carries it.
      console.error(`[${at}] WARN alert webhook delivery failed: ${err.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
