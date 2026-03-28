module.exports = {
  apps: [{
    name: "guildpilot",
    script: "index.js",
    watch: false,
    env_file: ".env",
    env: {
      NODE_ENV: "production"
    },
    max_memory_restart: "512M",
    restart_delay: 3000,
    max_restarts: 20,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  }]
};
