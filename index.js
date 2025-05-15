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

// 暫存 Buffer（所有裝置共用）
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

// 修改版：flush buffer 至 Firebase（使用 pair 陣列）
async function flushBufferList() {
  if (bufferList.length === 0) return;

  const historyMap = new Map(); // key: deviceId|date, value: [[timestamp, level], ...]
  const latestMap = new Map();

  for (const { deviceId, timestamp, level } of bufferList) {
    const tzOffset = 8 * 60 * 60 * 1000;
    const localDate = new Date(timestamp + tzOffset).toISOString().split('T')[0];
    const key = `${deviceId}|${localDate}`;

    if (!historyMap.has(key)) {
      historyMap.set(key, []);
    }
    historyMap.get(key).push([timestamp, level]);

    const prev = latestMap.get(deviceId);
    if (!prev || timestamp > prev.timestamp) {
      latestMap.set(deviceId, { timestamp, level });
    }
  }

  // 寫入 waterHistory（pair 陣列 append）
  for (const [key, dataPairs] of historyMap.entries()) {
    const [deviceId, dateStr] = key.split('|');
    const ref = db.ref(`waterHistory/${deviceId}/${dateStr}`);

    await ref.transaction(current => {
      return (current || []).concat(dataPairs);
    });
  }

  // 寫入 waterLatest
  const updates = {};
  for (const [deviceId, { timestamp, level }] of latestMap) {
    updates[`waterLatest/${deviceId}`] = { t: timestamp, l: level };
  }

  await db.ref().update(updates);
  bufferList.length = 0;
}

// 每 10 分鐘 flush buffer
setInterval(async () => {
  await flushBufferList();
}, 10 * 60 * 1000);

// 取得最新資料（含 buffer）
app.get('/latest/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;

  const bufferedData = bufferList
    .filter(d => d.deviceId === deviceId)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (bufferedData.length > 0) {
    const { timestamp, level } = bufferedData[0];
    return res.send({ timestamp, level });
  }

  const snapshot = await db.ref(`waterLatest/${deviceId}`).once('value');
  if (!snapshot.exists()) return res.send({});

  const val = snapshot.val();
  res.send({
    timestamp: val.t,
    level: val.l
  });
});

// 修改版：取得過去 3 天歷史資料（支援 pair 陣列 + buffer）
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
    const snapshot = await db.ref(`waterHistory/${deviceId}/${dateKey}`).once('value');
    const values = snapshot.val();

    if (Array.isArray(values)) {
      values.forEach(([ts, lv]) => {
        if (ts >= threeDaysAgo) {
          result.push({ timestamp: ts, level: lv });
        }
      });
    }
  }

  bufferList
    .filter(d => d.deviceId === deviceId && d.timestamp >= threeDaysAgo)
    .forEach(d => {
      result.push({ timestamp: d.timestamp, level: d.level });
    });

  result.sort((a, b) => a.timestamp - b.timestamp);
  res.send(result);
});

// 每日午夜清除 3 天前資料
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
