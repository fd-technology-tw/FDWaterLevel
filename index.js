const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');
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

// 暫存 buffer（所有裝置共用）
const bufferList = [];

// 上傳資料
app.post('/upload', async (req, res) => {
  const { deviceId, level } = req.body;
  if (!deviceId || typeof level !== 'number') {
    return res.status(400).send('Missing or invalid data');
  }

  const timestamp = Date.now();
  bufferList.push({ deviceId, timestamp, level });

  if (bufferList.length >= 100) {
    await flushBufferList();
  }

  res.send({ success: true });
});

// flush buffer 至 Firebase（使用 update 寫入 pair 陣列）
async function flushBufferList() {
  if (bufferList.length === 0) return;

  const historyMap = new Map();  // key: `deviceId|date`, value: [[t, l], ...]
  const latestMap = new Map();   // key: deviceId, value: { timestamp, level }

  for (const { deviceId, timestamp, level } of bufferList) {
    const tzOffset = 8 * 60 * 60 * 1000;
    const localDate = new Date(timestamp + tzOffset).toISOString().split('T')[0];
    const key = `${deviceId}|${localDate}`;
    const pair = [timestamp, level];

    if (!historyMap.has(key)) {
      historyMap.set(key, []);
    }
    historyMap.get(key).push(pair);

    const prev = latestMap.get(deviceId);
    if (!prev || timestamp > prev.timestamp) {
      latestMap.set(deviceId, { timestamp, level });
    }
  }

  // 逐筆 push 到對應的歷史路徑（增量寫入）
  for (const [key, pairs] of historyMap.entries()) {
    const [deviceId, dateStr] = key.split('|');
    const ref = db.ref(`waterHistory/${deviceId}/${dateStr}`);
    for (const pair of pairs) {
      await ref.push(pair);
    }
  }

  // 寫入最新資料
  const updates = {};
  for (const [deviceId, { timestamp, level }] of latestMap.entries()) {
    updates[`waterLatest/${deviceId}`] = { t: timestamp, l: level };
  }
  await db.ref().update(updates);

  bufferList.length = 0;
}


// 每 10 分鐘自動 flush
setInterval(async () => {
  await flushBufferList();
}, 10 * 60 * 1000);

// 取得最新資料（含 buffer）
app.get('/latest/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const buffered = bufferList
    .filter(d => d.deviceId === deviceId)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (buffered.length > 0) {
    const { timestamp, level } = buffered[0];
    return res.send({ timestamp, level });
  }

  const snapshot = await db.ref(`waterLatest/${deviceId}`).once('value');
  if (!snapshot.exists()) return res.send({});
  const val = snapshot.val();
  res.send({ timestamp: val.t, level: val.l });
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

  for (const dateStr of days) {
    const ref = db.ref(`waterHistory/${deviceId}/${dateStr}`);
    const snapshot = await ref.once('value');
    const arr = snapshot.val() || [];
    arr.forEach(([timestamp, level]) => {
      if (timestamp >= threeDaysAgo) {
        result.push({ timestamp, level });
      }
    });
  }

  bufferList
    .filter(d => d.deviceId === deviceId && d.timestamp >= threeDaysAgo)
    .forEach(d => result.push({ timestamp: d.timestamp, level: d.level }));

  result.sort((a, b) => a.timestamp - b.timestamp);
  res.send(result);
});

// 每日清除過期資料
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily cleanup...');
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const threeDaysAgoKey = threeDaysAgo.toISOString().split('T')[0];

  const devicesSnapshot = await db.ref('waterHistory').once('value');
  let deletedCount = 0;

  const deviceEntries = Object.entries(devicesSnapshot.val() || {});
  for (const [deviceId, dayMap] of deviceEntries) {
    for (const dateKey of Object.keys(dayMap)) {
      if (dateKey < threeDaysAgoKey) {
        await db.ref(`waterHistory/${deviceId}/${dateKey}`).remove();
        deletedCount++;
      }
    }
  }

  console.log(`Deleted ${deletedCount} outdated date folders.`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
