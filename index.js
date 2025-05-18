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

  // 若總筆數 >= 100 筆，寫入 Firebase
  if (bufferList.length >= 100) {
    await flushBufferList();
  }

  res.send({ success: true });
});

// flush buffer 至 Firebase（含 latest 儲存）
async function flushBufferList() {
  if (bufferList.length === 0) return;

  const updates = {};
  const latestMap = new Map(); // 每個 device 最新資料

  for (const { deviceId, timestamp, level } of bufferList) {
    const tzOffset = 8 * 60 * 60 * 1000;
    const localDate = new Date(timestamp + tzOffset);
    const dateString = localDate.toISOString().split('T')[0];
    const path = `waterHistory/${deviceId}/${dateString}/${timestamp}`;
    updates[path] = { l: level }; // 🔁 level → l

    // 記錄最新資料
    const prev = latestMap.get(deviceId);
    if (!prev || timestamp > prev.timestamp) {
      latestMap.set(deviceId, { timestamp, level });
    }
  }

  // 寫入 waterLatest
  for (const [deviceId, { timestamp, level }] of latestMap) {
    const latestPath = `waterLatest/${deviceId}`;
    updates[latestPath] = { t: timestamp, l: level }; // 🔁 timestamp → t, level → l
  }

  await db.ref().update(updates);
  bufferList.length = 0;
}

// 每 60 分鐘 flush buffer
setInterval(async () => {
  await flushBufferList();
}, 60 * 60 * 1000);

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
    timestamp: val.t, // 🔁 t → timestamp
    level: val.l      // 🔁 l → level
  });
});

// ✅ 優化過的：取得過去 3 天歷史資料（含 buffer）
app.get('/history/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const now = Date.now();
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;

  // 產生最近 3 天的日期字串
  const days = [0, 1, 2].map(offset => {
    const date = new Date(now - offset * 24 * 60 * 60 * 1000);
    return date.toISOString().split('T')[0];
  });

  const result = [];

  // 分日期查詢歷史資料
  for (const dateKey of days) {
    const ref = db.ref(`waterHistory/${deviceId}/${dateKey}`);
    const snapshot = await ref.once('value');

    snapshot.forEach(child => {
      const timestamp = Number(child.key);
      if (timestamp >= threeDaysAgo) {
        result.push({
          timestamp,
          level: child.val().l // 🔁 l → level
        });
      }
    });
  }

  // 加入 buffer 中尚未寫入的資料
  bufferList
    .filter(d => d.deviceId === deviceId && d.timestamp >= threeDaysAgo)
    .forEach(d => {
      result.push({ timestamp: d.timestamp, level: d.level });
    });

  // 時間排序
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
