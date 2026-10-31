// Firebase 版的 retrace：要登入（Firebase 的 ID token，匿名也可以）才能用；處理本身在 handler.js。
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { createHandler } = require('./handler');

admin.initializeApp();

const ORIGINS = ['https://climb-io.github.io', 'https://climbio.web.app', 'https://climbio-dev.web.app', 'https://climbio.firebaseapp.com', 'http://localhost:8765', 'http://127.0.0.1:8765'];
const PREVIEW = /^https:\/\/climbio--[a-z0-9-]+\.web\.app$/;   // Hosting 預覽網址（測試用）

exports.retrace = onRequest({ region: 'asia-east1', invoker: 'public', memory: '4GiB', cpu: 8, timeoutSeconds: 300, concurrency: 1, maxInstances: 2 }, createHandler({
  verify: (req) => admin.auth().verifyIdToken((req.get('authorization') || '').replace(/^Bearer /, '')),
  allowOrigin: (origin) => ORIGINS.includes(origin) || PREVIEW.test(origin),
}));
