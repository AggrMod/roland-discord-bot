function scoreSignals(signals, config = {}) {
  const normalizedSignals = signals || [];
  const total = normalizedSignals.reduce((sum, signal) => sum + Math.max(0, Number(signal.score) || 0), 0);
  const detectors = new Set(normalizedSignals.map(signal => String(signal.detector || '').trim()).filter(Boolean));
  const bonuses = (config?.risk?.combinationBonuses || []).reduce((sum, bonus) => {
    const required = Array.isArray(bonus?.detectors) ? bonus.detectors.map(String).filter(Boolean) : [];
    if (required.length > 0 && required.every(detector => detectors.has(detector))) return sum + Math.max(0, Number(bonus.score) || 0);
    return sum;
  }, 0);
  return Math.max(0, Math.min(100, total + bonuses));
}

function riskLevel(score, config = {}) {
  const thresholds = config?.risk || {};
  if (score >= Number(thresholds.quarantine || 80)) return 'critical';
  if (score >= Number(thresholds.timeout || 60)) return 'high';
  if (score >= Number(thresholds.warning || 35)) return 'medium';
  return 'low';
}

function decidePolicy(score, config) {
  const thresholds = config?.risk || {};
  if (score >= Number(thresholds.quarantine || 80)) return { action: 'quarantine', score };
  if (score >= Number(thresholds.timeout || 60)) return { action: 'timeout', score };
  if (score >= Number(thresholds.warning || 35)) return { action: 'warn', score };
  return { action: 'monitor', score };
}

module.exports = { scoreSignals, decidePolicy, riskLevel };
