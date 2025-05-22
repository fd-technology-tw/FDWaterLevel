const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');
const { LRUCache } = require('lru-cache'); // ✅ 使用新版語法
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

// 記憶體快取 - 最新資料（LRU）
const latestDataCache = new LRUCache({
  max: 10000, // 最多記住 10000 台裝置
  ttl: 1000 * 60 * 60 * 24 // 每筆資料保留最多 1 天（24 小時）
});

// 暫存 buffer（歷史資料寫入用）
const bufferList = [];

// 上傳資料
app.post('/upload', async (req, res) => {
  const { deviceId, level } = req.body;
  if (!deviceId || typeof level !== 'number') {
    return res.status(400).send('Missing or invalid data');
  }

  const timestamp = Date.now();
  bufferList.push({ deviceId, timestamp, level });

  // 同時更新記憶體最新快取
  latestDataCache.set(deviceId, { timestamp, level });

  // 若累積達 100 筆，flush 到 Firebase
  if (bufferList.length >= 100) {
    await flushBufferList();
  }

  res.send({ success: true });
});

// flush buffer 寫入 Firebase（含 waterLatest）
async function flushBufferList() {
  if (bufferList.length === 0) return;

  const updates = {};
  const latestMap = new Map();

  for (const { deviceId, timestamp, level } of bufferList) {
    const tzOffset = 8 * 60 * 60 * 1000;
    const localDate = new Date(timestamp + tzOffset);
    const dateString = localDate.toISOString().split('T')[0];
    const path = `waterHistory/${deviceId}/${dateString}/${timestamp}`;
    updates[path] = { l: level };

    const prev = latestMap.get(deviceId);
    if (!prev || timestamp > prev.timestamp) {
      latestMap.set(deviceId, { timestamp, level });
    }
  }

  // 寫入 waterLatest + 記憶體快取
  for (const [deviceId, { timestamp, level }] of latestMap) {
    updates[`waterLatest/${deviceId}`] = { t: timestamp, l: level };
    latestDataCache.set(deviceId, { timestamp, level }); // 🔁 同步更新記憶體
  }

  await db.ref().update(updates);
  bufferList.length = 0;
}

// 每 60 分鐘 flush buffer
setInterval(async () => {
  await flushBufferList();
}, 60 * 60 * 1000);

// 取得最新資料（先查快取，再查 Firebase）
app.get('/latest/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;

  // 先查記憶體快取
  const cached = latestDataCache.get(deviceId);
  if (cached) {
    return res.send({
      timestamp: cached.timestamp,
      level: cached.level
    });
  }

  // 找不到就查 Firebase
  const snapshot = await db.ref(`waterLatest/${deviceId}`).once('value');
  if (!snapshot.exists()) return res.send({});

  const val = snapshot.val();
  const latest = { timestamp: val.t, level: val.l };

  // 寫入快取以便下次使用
  latestDataCache.set(deviceId, latest);

  res.send(latest);
});

// 取得過去 3 天歷史資料（含 buffer）
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
    const ref = db.ref(`waterHistory/${deviceId}/${dateKey}`);
    const snapshot = await ref.once('value');

    snapshot.forEach(child => {
      const timestamp = Number(child.key);
      if (timestamp >= threeDaysAgo) {
        result.push({
          timestamp,
          level: child.val().l
        });
      }
    });
  }

  // 加入尚未寫入的 buffer 資料
  bufferList
    .filter(d => d.deviceId === deviceId && d.timestamp >= threeDaysAgo)
    .forEach(d => {
      result.push({ timestamp: d.timestamp, level: d.level });
    });

  result.sort((a, b) => a.timestamp - b.timestamp);
  res.send(result);
});

// 每日清除過期的歷史資料（只保留近 3 天）
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily cleanup...');
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const threeDaysAgoKey = threeDaysAgo.toISOString().split('T')[0];

  const devicesSnapshot = await db.ref('waterHistory').once('value');
  let deletedCount = 0;

  const deviceEntries = Object.entries(devicesSnapshot.val() || {});
  for (const [deviceId] of deviceEntries) {
    const deviceRef = db.ref(`waterHistory/${deviceId}`);
    const outdatedSnapshot = await deviceRef
      .orderByKey()
      .endAt(threeDaysAgoKey)
      .once('value');

    outdatedSnapshot.forEach(dateSnap => {
      dateSnap.ref.remove();
      deletedCount++;
    });
  }

  console.log(`Deleted ${deletedCount} outdated date folders.`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
