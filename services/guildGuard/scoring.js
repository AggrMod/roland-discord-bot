function scoreSignals(signals) {
  return Math.max(0, Math.min(100, (signals || []).reduce((total, signal) => total + Math.max(0, Number(signal.score) || 0), 0)));
}

function decidePolicy(score, config) {
  const thresholds = config?.risk || {};
  if (score >= Number(thresholds.quarantine || 80)) return { action: 'quarantine', score };
  if (score >= Number(thresholds.timeout || 60)) return { action: 'timeout', score };
  if (score >= Number(thresholds.warning || 35)) return { action: 'warn', score };
  return { action: 'monitor', score };
}

module.exports = { scoreSignals, decidePolicy };
