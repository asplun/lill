// PM2 配置 — 宝塔 / 1Panel / 裸机通用
// 用法：在 backend 目录下执行 `pm2 start ecosystem.config.js`
module.exports = {
  apps: [{
    name: 'lill-backend',
    script: 'server.js',
    cwd: __dirname,          // 自动定位到本文件所在目录，无需手动改路径
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '127.0.0.1',
      // ⚠️ 生产环境务必设置固定 JWT_SECRET，否则每次重启后所有登录会失效
      // 生成随机密钥：openssl rand -hex 32
      // 填好后取消下面这行注释：
      // JWT_SECRET: '在这里粘贴你的随机密钥',
    }
  }]
};
