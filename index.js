const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');
const { LRUCache } = require('lru-cache');

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化 Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://fdwaterlevel-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();
app.use(express.json());

// 快取：最新資料（LRU）
const latestDataCache = new LRUCache({
  max: 10000,
  ttl: 1000 * 60 * 60 * 24
});

// 暫存 Buffer
const bufferList = [];

// 上傳水位資料
app.post('/upload', async (req, res) => {
  const { deviceId, level } = req.body;
  if (!deviceId || typeof level !== 'number') {
    return res.status(400).send('Missing or invalid data');
  }

  const timestamp = Date.now();
  bufferList.push({ deviceId, timestamp, level });
  latestDataCache.set(deviceId, { timestamp, level });

  if (bufferList.length >= 100) {
    await flushBufferList();
  }

  res.send({ success: true });
});

// 批次寫入 Firebase
async function flushBufferList() {
  if (bufferList.length === 0) return;

  const updates = {};
  const latestMap = new Map();

  for (const { deviceId, timestamp, level } of bufferList) {
    const tzOffset = 8 * 60 * 60 * 1000; // UTC+8
    const localDate = new Date(timestamp + tzOffset);
    const dateKey = localDate.toISOString().split('T')[0];

    const path = `waterHistory/${dateKey}/${deviceId}/${timestamp}`;
    updates[path] = { l: level };

    const prev = latestMap.get(deviceId);
    if (!prev || timestamp > prev.timestamp) {
      latestMap.set(deviceId, { timestamp, level });
    }
  }

  for (const [deviceId, { timestamp, level }] of latestMap) {
    updates[`waterLatest/${deviceId}`] = { t: timestamp, l: level };
    latestDataCache.set(deviceId, { timestamp, level });
  }

  await db.ref().update(updates);
  bufferList.length = 0;
}

// 每小時 flush buffer
setInterval(async () => {
  await flushBufferList();
}, 60 * 60 * 1000);

// 查詢裝置最新資料（含快取）
app.get('/latest/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;

  const cached = latestDataCache.get(deviceId);
  if (cached) {
    return res.send({ timestamp: cached.timestamp, level: cached.level });
  }

  const snapshot = await db.ref(`waterLatest/${deviceId}`).once('value');
  if (!snapshot.exists()) return res.send({});

  const val = snapshot.val();
  const latest = { timestamp: val.t, level: val.l };
  latestDataCache.set(deviceId, latest);

  res.send(latest);
});

// 查詢過去 3 天歷史資料（含 buffer）
app.get('/history/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const now = Date.now();
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;

  const days = [0, 1, 2].map(offset => {
    const date = new Date(now - offset * 24 * 60 * 60 * 1000);
    return date.toISOString().split('T')[0];
  });

  const result = [];

  for (const dateKey of days) {
    const ref = db.ref(`waterHistory/${dateKey}/${deviceId}`);
    const snapshot = await ref.once('value');

    snapshot.forEach(child => {
      const timestamp = Number(child.key);
      if (timestamp >= threeDaysAgo) {
        result.push({ timestamp, level: child.val().l });
      }
    });
  }

  bufferList
    .filter(d => d.deviceId === deviceId && d.timestamp >= threeDaysAgo)
    .forEach(d => result.push({ timestamp: d.timestamp, level: d.level }));

  result.sort((a, b) => a.timestamp - b.timestamp);
  res.send(result);
});

// 每日清除過期資料（保留近 3 天）
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily cleanup...');
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const threeDaysAgoKey = threeDaysAgo.toISOString().split('T')[0];

  const snapshot = await db.ref('waterHistory').once('value');
  const folders = Object.keys(snapshot.val() || {});
  let deletedCount = 0;

  for (const dateKey of folders) {
    if (dateKey <= threeDaysAgoKey) {
      await db.ref(`waterHistory/${dateKey}`).remove();
      deletedCount++;
    }
  }

  console.log(`Deleted ${deletedCount} outdated date folders.`);
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
