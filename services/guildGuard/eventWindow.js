class EventWindowStore {
  constructor({ maxEntriesPerKey = 100, maxKeys = 5000 } = {}) {
    this.maxEntriesPerKey = Math.max(10, Number(maxEntriesPerKey) || 100);
    this.maxKeys = Math.max(100, Number(maxKeys) || 5000);
    this.entries = new Map();
    this.guildEntries = new Map();
  }

  key(guildId, userId) {
    return `${String(guildId || '')}:${String(userId || '')}`;
  }

  prune(entries, now, windowMs) {
    const cutoff = now - Math.max(1000, Number(windowMs) || 10000);
    return entries.filter(entry => Number(entry.timestamp) >= cutoff);
  }

  record(event) {
    if (!event?.guildId || !event?.userId) return [];
    const key = this.key(event.guildId, event.userId);
    const current = this.entries.get(key) || [];
    current.push(event);
    const retained = current.slice(-this.maxEntriesPerKey);
    this.entries.set(key, retained);
    if (event.guildId) {
      const guildCurrent = this.guildEntries.get(String(event.guildId)) || [];
      this.guildEntries.set(String(event.guildId), [...guildCurrent, event].slice(-this.maxEntriesPerKey * 10));
    }
    this.trimKeys();
    return retained;
  }

  getRecent(guildId, userId, windowMs = 10000, now = Date.now()) {
    const key = this.key(guildId, userId);
    const current = this.entries.get(key) || [];
    const retained = this.prune(current, Number(now) || Date.now(), windowMs);
    if (retained.length === 0) this.entries.delete(key);
    else this.entries.set(key, retained);
    return retained.slice();
  }

  getRecentGuild(guildId, windowMs = 60000, now = Date.now()) {
    const key = String(guildId || '');
    const current = this.guildEntries.get(key) || [];
    const retained = this.prune(current, Number(now) || Date.now(), windowMs);
    if (retained.length === 0) this.guildEntries.delete(key);
    else this.guildEntries.set(key, retained);
    return retained.slice();
  }

  trimKeys() {
    while (this.entries.size > this.maxKeys) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  clear() {
    this.entries.clear();
    this.guildEntries.clear();
  }
}

module.exports = EventWindowStore;
