/**
 * Deciding which model a request body names before it reaches the upstream,
 * shared by every rule that refuses requests by model: the per-account
 * low-quota guard on Codex, and the console-wide block rules on both
 * gateways.
 *
 * One reader and one idea of "the model field" for all of them. Two gates that
 * disagreed about which model a body carried would each be bypassable through
 * the gap between them.
 */

import { Transform } from 'node:stream';
import { TopLevelJsonScanner } from './request-metadata.js';
import { modelBlockRuleFor } from './model-block-rules.js';

/**
 * How much of the request body a gate will read looking for `model`.
 *
 * The Codex CLI and Claude Code both serialize `model` first, so in practice
 * this is satisfied by the first chunk. The bound exists for the body that
 * never names a model early: without it the gate would buffer an entire 32 MB
 * upload before ruling. Past the bound the body streams on and is still
 * checked, chunk by chunk, by the tail below.
 */
export const MODEL_GATE_PREFIX_BYTES = 64 * 1024;

/**
 * Read the head of a request body far enough to learn its `model`, and hand
 * back the bytes that were consumed so the caller can put them in front of the
 * body it forwards.
 *
 * The stream is left paused with its listeners removed, so a caller that
 * decides to proceed can pipe it as usual. `ended` means the whole body was
 * consumed here and there is nothing left to pipe — piping an already-ended
 * stream delivers neither data nor 'end', which would hang the forward path.
 */
export function readModelPrefix(req, { limitBytes = MODEL_GATE_PREFIX_BYTES } = {}) {
  return new Promise((resolve) => {
    const scanner = new TopLevelJsonScanner();
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onFailure);
      req.off('aborted', onFailure);
      if (!result.ended && !result.aborted) req.pause();
      resolve({
        model: null,
        ended: false,
        aborted: false,
        ...result,
        head: chunks.length ? Buffer.concat(chunks) : null,
        bytes,
        // Handed on so the rest of the body can be checked with the same
        // parse state, rather than restarting mid-object where nothing parses.
        scanner,
      });
    };

    function onData(chunk) {
      chunks.push(chunk);
      bytes += chunk.length;
      // Every byte handed back as `head` is scanned, including the rest of the
      // chunk that crosses the limit or carries the model. The scanner is
      // handed on to check the remainder of the body; a byte it never saw
      // would leave it parsing from the middle of a string, where a second
      // `model` could hide and an honest body reads as garbage. The limit
      // bounds how many reads are taken, so the most this buffers is the limit
      // plus one socket read.
      try {
        scanner.push(chunk);
      } catch {
        scanner.fail();
        settle({ model: null });
        return;
      }
      const { model, parseState } = scanner.snapshot();
      if (model !== null) settle({ model });
      // 'invalid' and 'not_object' are terminal: no later byte can produce a
      // model, so there is nothing to gain by buffering the rest.
      else if (parseState === 'invalid' || parseState === 'not_object') settle({ model: null });
      else if (bytes >= limitBytes) settle({ model: null });
    }

    function onEnd() {
      try {
        scanner.finish();
      } catch {
        settle({ model: null, ended: true });
        return;
      }
      settle({ model: scanner.snapshot().model, ended: true });
    }

    function onFailure() {
      settle({ model: null, aborted: true });
    }

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onFailure);
    req.once('aborted', onFailure);
    req.resume();
  });
}

export class ModelGateViolation extends Error {
  constructor(refusal) {
    super(refusal.code);
    this.name = 'ModelGateViolation';
    this.code = refusal.code;
    this.refusal = refusal;
  }
}

/**
 * A per-request verdict on one model id: null to let it through, or why not.
 *
 * Block rules are asked first. When a model is both blocked outright and
 * outside a biting low-quota guard, the rule's message is the useful one — it
 * says what to use instead, which is true whatever the quota does next.
 */
export function createModelJudge({ rules = [], guardAllows = null } = {}) {
  // The tail asks again after every chunk once the model is known, and it is
  // nearly always the same model; the verdict is kept rather than recomputed.
  let lastModel;
  let lastVerdict = null;
  return (model) => {
    if (model === lastModel) return lastVerdict;
    const rule = modelBlockRuleFor(rules, model);
    let verdict = null;
    if (rule) verdict = { code: 'model_blocked', rule, model };
    else if (guardAllows && !guardAllows(model)) verdict = { code: 'model_not_allowed', model };
    lastModel = model;
    lastVerdict = verdict;
    return verdict;
  };
}

/**
 * Why a body must be stopped on what the scanner has read so far, or null.
 *
 * The model is not the only thing to check, because a gate and the upstream
 * need not agree on what "the model" of a body is:
 *
 * - `duplicate_model`: JSON leaves duplicate keys undefined. Python keeps the
 *   last one; a gate reading a prefix sees the first. A body naming an allowed
 *   model and then a blocked one would pass here and run the blocked one there.
 * - `unparseable`: this scanner is strict JSON, and some upstream parsers are
 *   not — Python accepts `NaN`. Past a construct only the upstream can read,
 *   the gate is blind to anything that follows it, so a body it cannot parse
 *   to the end is not a body it can vouch for.
 *
 * Both fail closed. Neither shape comes from a real client, and the metrics of
 * the busiest deployment show the scanner reading a model from every request
 * it forwarded; the cost of a false refusal is bounded by an operator being
 * able to switch the rules off from the console.
 */
export function modelGateViolation(scanner, judge) {
  if (scanner.modelKeys > 1) return { code: 'duplicate_model' };
  const { parseState, model } = scanner.snapshot();
  if (parseState === 'invalid' || parseState === 'not_object') return { code: 'unparseable' };
  if (model !== null) return judge(model);
  return null;
}

/**
 * The verdict on a body's head, as read by `readModelPrefix`.
 *
 * `requireModel` is the low-quota guard's rule: under it, only a body that
 * names an allowed model early may proceed, so a head with no model in it is
 * refused. Block rules alone do not need that — a model that turns up later
 * is judged by the tail when it arrives.
 */
export function modelHeadRefusal(prefix, judge, { requireModel = false } = {}) {
  if (prefix.model === null) {
    if (requireModel) return { code: 'model_not_allowed', model: null };
    return modelGateViolation(prefix.scanner, judge);
  }
  return judge(prefix.model) ?? modelGateViolation(prefix.scanner, judge);
}

/**
 * Scan the rest of a gated body as it streams past, and stop it the moment
 * it stops being one the gate can vouch for.
 *
 * A chunk is only passed on after it has been scanned, so a violation found in
 * it means that chunk is withheld: the upstream is left holding an incomplete
 * body, which it cannot run, and the caller destroys the request. Nothing is
 * buffered beyond the chunk in hand, so this costs no memory on a large body.
 */
export function createModelGateTail(scanner, judge) {
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        scanner.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      } catch {
        scanner.fail();
      }
      const refusal = modelGateViolation(scanner, judge);
      if (refusal) {
        callback(new ModelGateViolation(refusal));
        return;
      }
      callback(null, chunk);
    },
  });
}
