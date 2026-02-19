module.exports = {
  apps: [
    {
      name: 'kiosk-hub',
      script: 'hub.js',
      cwd: '/Users/noc/operations/kiosk-hub',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: 3750,
        HUB_TOKEN: 'skynet-kiosk-token-2025'
      },
      max_memory_restart: '256M',
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/Users/noc/.pm2/logs/kiosk-hub-error.log',
      out_file: '/Users/noc/.pm2/logs/kiosk-hub-out.log'
    }
  ]
};
