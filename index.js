import { createServer } from "http"; import { Server } from "socket.io";
import { createClient } from 'redis';
import { createConnection } from 'mysql2';


// Set up redis client.
const redisClient = createClient();
redisClient.on('error', err => console.log('Redis Client Error', err))
await redisClient.connect()

const httpServer = createServer();
const io = new Server(httpServer, { 
    cors: {
      origin: "http://localhost:8000",
    },
 });

async function getMySQLConnection() {
  var mySqlClient = createConnection({
    host: "localhost",
    user: "user",
    password: "password",
    database: "toktik-db"
  });

  mySqlClient.connect(function(err) {
    if (err) throw err;
  });

  return mySqlClient;
}

async function getViewCount(videoKey) {
  const connection = await getMySQLConnection();
  const sql = 'SELECT videos.views FROM videos WHERE videos.key = ?';
  const results = await connection.promise().query(sql, [videoKey])
  return results[0][0].views;  
}

// Run this when a user needs to be subscribed to a video.
async function handleVideo(socket, info) {
  socket.join(info.video+'room');

  // Serve the view count.
  handleVideoViewCount(info);
}

async function handleVideoViewCount(info) {
  // Data expiry time. 
  // After the interval, the value will get updated.
  const expiryTime = 5;

  // Check whether there is a value cached in the redis.
  const videoKey = info.video+'key';
  var value = await redisClient.get(videoKey);
  
  if (value == null) {
    const viewCountFromDatabase = await getViewCount(info.video);
    await redisClient.set(videoKey, viewCountFromDatabase, { EX: expiryTime * 2 });
    value = viewCountFromDatabase;
  }
  
  io.to(info.video+'room').emit("update", { 'room':info.video, 'value':value });
}

io.on("connection", (socket) => {
  // Client requesting for view count of a particular video.
  socket.on("video", (info) => handleVideo(socket, info));
  socket.on('getNewViewCount', (info) => handleVideoViewCount(info));
});

console.log("Started server on port 5001.");
httpServer.listen(5001);