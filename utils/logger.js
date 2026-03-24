class Logger {
  log(message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INFO]`, message, ...args);
  }

  error(message, ...args) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR]`, message, ...args);
  }

  warn(message, ...args) {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] [WARN]`, message, ...args);
  }

  debug(message, ...args) {
    const timestamp = new Date().toISOString();
    console.debug(`[${timestamp}] [DEBUG]`, message, ...args);
  }
}

module.exports = new Logger();
