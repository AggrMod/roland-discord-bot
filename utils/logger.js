class Logger {
  constructor() {
    this.levels = Object.freeze({
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    });
    const requested = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase();
    this.activeLevel = this.levels[requested] !== undefined ? requested : 'info';
  }

  shouldLog(level) {
    const normalized = String(level || '').trim().toLowerCase();
    const active = this.levels[this.activeLevel];
    const current = this.levels[normalized];
    if (active === undefined || current === undefined) return true;
    return current <= active;
  }

  formatPrefix(level) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${String(level || '').toUpperCase()}]`;
  }

  log(message, ...args) {
    if (!this.shouldLog('info')) return;
    console.log(this.formatPrefix('info'), message, ...args);
  }

  error(message, ...args) {
    if (!this.shouldLog('error')) return;
    console.error(this.formatPrefix('error'), message, ...args);
  }

  warn(message, ...args) {
    if (!this.shouldLog('warn')) return;
    console.warn(this.formatPrefix('warn'), message, ...args);
  }

  debug(message, ...args) {
    if (!this.shouldLog('debug')) return;
    console.debug(this.formatPrefix('debug'), message, ...args);
  }
}

module.exports = new Logger();
