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

// flush buffer 至 Firebase
async function flushBufferList() {
  if (bufferList.length === 0) return;

  const updates = {};
  for (const { deviceId, timestamp, level } of bufferList) {
    const tzOffset = 8 * 60 * 60 * 1000;
    const localDate = new Date(timestamp + tzOffset);
    const dateString = localDate.toISOString().split('T')[0];
    const path = `waterHistory/${deviceId}/${dateString}/${timestamp}`;
    updates[path] = { level };
  }

  await db.ref().update(updates);
  bufferList.length = 0;
}

// 每 10 分鐘 flush buffer
setInterval(async () => {
  //console.log('Timer triggered buffer flush...');
  await flushBufferList();
}, 10 * 60 * 1000);

// 取得最新資料（含 buffer）
app.get('/latest/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;

  // 從 buffer 取出該裝置資料
  const bufferedData = bufferList
    .filter(d => d.deviceId === deviceId)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (bufferedData.length > 0) {
    const { timestamp, level } = bufferedData[0];
    return res.send({ timestamp, level });
  }

  // 若 buffer 無資料則讀取 Firebase
  const deviceRef = db.ref(`waterHistory/${deviceId}`);
  const dateSnapshot = await deviceRef.orderByKey().limitToLast(1).once('value');

  let latestData = {};
  dateSnapshot.forEach((dateChild) => {
    dateChild.forEach((timestampChild) => {
      latestData = {
        timestamp: Number(timestampChild.key),
        ...timestampChild.val()
      };
    });
  });

  res.send(latestData);
});

// 取得過去 7 天歷史資料（含 buffer）
app.get('/history/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const deviceRef = db.ref(`waterHistory/${deviceId}`);
  const dateSnapshot = await deviceRef.once('value');

  const result = [];

  // 先取 Firebase
  dateSnapshot.forEach((dateChild) => {
    dateChild.forEach((timestampChild) => {
      const timestamp = Number(timestampChild.key);
      if (timestamp >= sevenDaysAgo) {
        result.push({
          timestamp,
          ...timestampChild.val()
        });
      }
    });
  });

  // 加入 buffer 資料
  bufferList
    .filter(d => d.deviceId === deviceId && d.timestamp >= sevenDaysAgo)
    .forEach(d => {
      result.push({ timestamp: d.timestamp, level: d.level });
    });

  // 按時間排序
  result.sort((a, b) => a.timestamp - b.timestamp);
  res.send(result);
});

// 定時清除過期資料（每日午夜）
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily cleanup...');
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const ref = db.ref('waterHistory');
  const snapshot = await ref.once('value');

  let deletedCount = 0;

  snapshot.forEach((deviceSnapshot) => {
    deviceSnapshot.forEach((dateSnapshot) => {
      const date = dateSnapshot.key;
      const dateTimestamp = new Date(date).getTime() + 8 * 60 * 60 * 1000;
      if (dateTimestamp < sevenDaysAgo) {
        dateSnapshot.ref.remove();
        deletedCount++;
      }
    });
  });

  console.log(`Deleted ${deletedCount} outdated date folders.`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
