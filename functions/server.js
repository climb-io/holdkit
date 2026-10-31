// 一般 Node 伺服器版的 retrace（Docker、Cloud Run、Fly、自己的機器），跟 Firebase 版共用 handler.js。
// 環境變數：
//   PORT：預設 8080
//   AUTH：key（預設，Authorization: Bearer 要等於 API_KEY）｜firebase（Firebase 的 ID token，憑證用 GOOGLE_APPLICATION_CREDENTIALS 或執行環境的預設憑證）｜none（不驗證，只在本機或私人網路用）
//   ORIGINS：允許跨網域呼叫的網站，逗號分隔；* 是全部
//   SAM_CPUS：encoder 執行緒數和解碼 Worker 數，照分到的 vCPU 設（預設 8）
const crypto = require('crypto');
const express = require('express');
const { createHandler } = require('./handler');

const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer /, '');
const digest = (s) => crypto.createHash('sha256').update(s).digest();
const verifiers = {
  key: async (req) => {
    if (!process.env.API_KEY || !crypto.timingSafeEqual(digest(bearer(req)), digest(process.env.API_KEY))) throw new Error('bad key');
  },
  firebase: async (req) => {
    const admin = require('firebase-admin');
    if (!admin.apps.length) admin.initializeApp();
    await admin.auth().verifyIdToken(bearer(req));
  },
  none: async () => {},
};
const auth = process.env.AUTH || 'key';
if (!verifiers[auth]) throw new Error(`AUTH 要是 ${Object.keys(verifiers).join('、')} 其中一個，不是 ${auth}`);
const origins = (process.env.ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.all('/', createHandler({ verify: verifiers[auth], allowOrigin: (origin) => origins.includes('*') || origins.includes(origin) }));
const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log(`retrace：http://localhost:${port}/（AUTH=${auth}）`));
