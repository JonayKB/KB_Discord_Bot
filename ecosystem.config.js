module.exports = {
  apps: [
    {
      name: "botdiscord",
      script: "./dist/index.js",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production"
      },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
    }
  ]
};
