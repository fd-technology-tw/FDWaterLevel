const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');
const app = express();
const PORT = process.env.PORT || 3000;

// 讀取金鑰
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://fdwaterlevel-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();
app.use(express.json());

// 轉換 timestamp 成 YYYY-MM-DD 字串
function getDateString(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = (`0${date.getMonth() + 1}`).slice(-2);
  const day = (`0${date.getDate()}`).slice(-2);
  return `${year}-${month}-${day}`;
}

// 取得 N 天前的日期字串
function getDateNDaysAgo(n) {
  const date = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const year = date.getFullYear();
  const month = (`0${date.getMonth() + 1}`).slice(-2);
  const day = (`0${date.getDate()}`).slice(-2);
  return `${year}-${month}-${day}`;
}

// ------------------ API ------------------

// 上傳資料
app.post('/upload', async (req, res) => {
  const { deviceId, level } = req.body;
  if (!deviceId || typeof level !== 'number') {
    return res.status(400).send('Missing or invalid data');
  }

  const timestamp = Date.now();
  const dateString = getDateString(timestamp);
  const path = `waterHistory/${deviceId}/${dateString}/${timestamp}`;
  
  try {
    await db.ref(path).set({ level, timestamp });
    res.send({ success: true });
  } catch (error) {
    console.error('Error uploading data:', error);
    res.status(500).send('Internal server error');
  }
});

// 取得最新資料
app.get('/latest/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const ref = db.ref(`waterHistory/${deviceId}`);

  try {
    const snapshot = await ref.once('value');
    let latestTimestamp = 0;
    let latestData = null;

    snapshot.forEach((dateSnapshot) => {
      dateSnapshot.forEach((timeSnapshot) => {
        const data = timeSnapshot.val();
        if (data.timestamp > latestTimestamp) {
          latestTimestamp = data.timestamp;
          latestData = data;
        }
      });
    });

    res.send(latestData || {});
  } catch (error) {
    console.error('Error fetching latest data:', error);
    res.status(500).send('Internal server error');
  }
});

// 取得最近 7 天歷史資料
app.get('/history/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const ref = db.ref(`waterHistory/${deviceId}`);

  try {
    const snapshot = await ref.once('value');
    let historyData = {};

    snapshot.forEach((dateSnapshot) => {
      const dateKey = dateSnapshot.key;
      const dateTimestamp = new Date(dateKey).getTime();

      if (dateTimestamp >= sevenDaysAgo) {
        dateSnapshot.forEach((timeSnapshot) => {
          const data = timeSnapshot.val();
          if (data.timestamp >= sevenDaysAgo) {
            historyData[timeSnapshot.key] = data;
          }
        });
      }
    });

    res.send(historyData);
  } catch (error) {
    console.error('Error fetching history data:', error);
    res.status(500).send('Internal server error');
  }
});

// ------------------ 定時清理 ------------------

// 每天凌晨 00:00 刪除 7 天前的舊資料
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily cleanup task...');
  const cutoffDate = getDateNDaysAgo(7);

  try {
    const snapshot = await db.ref('waterHistory').once('value');
    let deletedCount = 0;
    const deletePromises = [];

    snapshot.forEach((deviceSnapshot) => {
      const deviceId = deviceSnapshot.key;

      deviceSnapshot.forEach((dateSnapshot) => {
        const dateKey = dateSnapshot.key;
        if (dateKey < cutoffDate) {
          const ref = db.ref(`waterHistory/${deviceId}/${dateKey}`);
          deletePromises.push(ref.remove());
          deletedCount++;
        }
      });
    });

    await Promise.all(deletePromises);
    console.log(`Deleted ${deletedCount} outdated date entries before ${cutoffDate}.`);
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
});

// ------------------ 啟動服務 ------------------

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
