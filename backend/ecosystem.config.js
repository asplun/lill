module.exports = {
  apps: [{
    name: 'lill-backend',
    script: 'server.js',
    cwd: '/www/wwwroot/lill-v2/backend',
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '127.0.0.1',
      JWT_SECRET: '754b5f1b78af0f0b4cfc7c34814978a0ca4724a88bbaf555046d9684d1ee3555',
    }
  }]
};
