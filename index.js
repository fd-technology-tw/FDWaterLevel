const express = require('express');
const admin = require('firebase-admin');
const app = express();
const PORT = process.env.PORT || 3000;

admin.initializeApp({
  credential: admin.credential.cert(require('./firebase-key.json')),
  databaseURL: 'https://YOUR_PROJECT_ID.firebaseio.com'
});

const db = admin.database();

app.use(express.json());

// 上傳資料
app.post('/upload', async (req, res) => {
  const { deviceId, level } = req.body;
  if (!deviceId || typeof level !== 'number') {
    return res.status(400).send('Missing or invalid data');
  }

  const timestamp = Date.now();
  const path = `waterHistory/${deviceId}/${timestamp}`;
  await db.ref(path).set({ level, timestamp });

  res.send({ success: true });
});

// 取得最新資料
app.get('/latest/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const ref = db.ref(`waterHistory/${deviceId}`);
  const snapshot = await ref.orderByKey().limitToLast(1).once('value');

  res.send(snapshot.val() || {});
});

// 取得歷史資料（7 天內）
app.get('/history/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const ref = db.ref(`waterHistory/${deviceId}`);
  const snapshot = await ref.orderByKey().startAt(sevenDaysAgo.toString()).once('value');

  res.send(snapshot.val() || {});
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
