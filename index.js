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

// 上傳資料（使用台灣時間分日期）
app.post('/upload', async (req, res) => {
  const { deviceId, level } = req.body;
  if (!deviceId || typeof level !== 'number') {
    return res.status(400).send('Missing or invalid data');
  }

  const timestamp = Date.now();
  const tzOffset = 8 * 60 * 60 * 1000; // 台灣為 UTC+8，毫秒
  const localDate = new Date(timestamp + tzOffset);
  const dateString = localDate.toISOString().split('T')[0]; // e.g., "2025-04-30"

  const path = `waterHistory/${deviceId}/${dateString}/${timestamp}`;
  await db.ref(path).set({ level });

  res.send({ success: true });
});

// 取得最新資料
app.get('/latest/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
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

// 取得過去 7 天內的歷史資料（比對 UTC timestamp）
app.get('/history/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const deviceRef = db.ref(`waterHistory/${deviceId}`);
  const dateSnapshot = await deviceRef.once('value');

  const result = [];

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

  res.send(result);
});

// 定時清除 7 天前的資料（以台灣日期為依據）
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
      const dateTimestamp = new Date(date).getTime() + 8 * 60 * 60 * 1000; // ✅ 台灣時間偏移
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
