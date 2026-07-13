const { normalizeEvent } = require('./normalizer');
const { scoreSignals, decidePolicy } = require('./scoring');

class DetectionPipeline {
  constructor({ detectors = [], isExempt, recordIncident, recordSignals, getConfig, eventWindow, applyAction, detectorContext = {} }) {
    this.detectors = detectors;
    this.isExempt = isExempt;
    this.recordIncident = recordIncident;
    this.recordSignals = recordSignals;
    this.getConfig = getConfig;
    this.eventWindow = eventWindow;
    this.applyAction = applyAction;
    this.detectorContext = detectorContext;
  }

  async process(input, eventType = 'message_create', options = {}) {
    const event = normalizeEvent(input, eventType);
    if (!event.guildId) return { event, skipped: true, reason: 'missing_guild' };
    const config = await this.getConfig(event.guildId);
    if (!options.force && !config.enabled) return { event, skipped: true, reason: 'disabled' };
    if (!options.force && this.isExempt(event, config)) return { event, skipped: true, reason: 'exempt' };

    if (this.eventWindow) this.eventWindow.record(event);

    const signals = [];
    for (const detector of this.detectors) {
      if (!detector || typeof detector.detect !== 'function') continue;
      const detected = await detector.detect(event, { config, eventWindow: this.eventWindow, ...this.detectorContext });
      if (Array.isArray(detected)) signals.push(...detected);
      else if (detected) signals.push(detected);
    }

    if (signals.length === 0 && !options.recordEmpty) {
      return { event, config, signals, score: 0, decision: decidePolicy(0, config), incident: null };
    }

    const score = scoreSignals(signals, config);
    if (signals.length > 0) await this.recordSignals(event, signals, config);
    const incident = await this.recordIncident(event, signals, score, {
      action: decidePolicy(score, config).action,
      channelId: event.channelId,
      rawContent: event.rawContent,
      urls: event.urls,
      mentions: event.mentions
    }, options.incidentStatus);
    const decision = decidePolicy(score, config);
    const action = this.applyAction
      ? await this.applyAction({ source: input, event, decision, config, incident, signals })
      : null;
    return { event, config, signals, score, decision, incident, action };
  }
}

module.exports = DetectionPipeline;
