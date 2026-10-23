// PM2 配置 — 宝塔 / 1Panel / 裸机通用
// 用法：在 backend 目录下执行 `pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [{
    name: 'lill-backend',
    script: 'server.js',
    cwd: __dirname,          // 自动定位到本文件所在目录，无需手动改路径
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M'
  }]
};
