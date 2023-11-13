import { createServer } from "http"; import { Server } from "socket.io";
import { createClient } from 'redis';
import { createConnection } from 'mysql2';

// TODO: Move this into multiple files later for better organization.

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
  connection.end();
  return results[0][0].views;  
}

async function getLikeCount(videoID) {
  const connection = await getMySQLConnection();

  // // Get the like count.
  const sql = 'SELECT COUNT(*) AS like_count FROM video_likes WHERE video_likes.video_id = ? AND video_likes.like = true';
  const results = await connection.promise().query(sql, [videoID])
  connection.end();
 
  return results[0][0]['like_count'];  
}

// Returns whether the user liked the video or not.
async function getUserLike(videoID, userID) {
  const connection = await getMySQLConnection();

  // // Get the like count.
  const sql = 'SELECT * FROM video_likes WHERE video_likes.video_id = ? AND video_likes.user_id = ?';
  const results = await connection.promise().query(sql, [videoID, userID]);
  connection.end();

  return results[0];  
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
    value = await getViewCount(info.video);
    await redisClient.set(videoKey, value, { EX: expiryTime * 2 });
  }
  
  console.log("Value: ", value);
  
  io.to(info.video+'room').emit("update", { 'room':info.video, 'value':value });
}

async function handleVideoLikeToggle(info) {
  const connection = await getMySQLConnection();
  const userLike = await getUserLike(info.videoID, info.userID);

  console.log(userLike);

  if (userLike.length == 0) 
  {
    // The user's like entry does not exist in the database. Let's change that.
    const sql = 'INSERT INTO video_likes(video_id, user_id, video_likes.like) VALUES (?, ?, ?)';
    await connection.promise().query(sql, [ info.videoID, info.userID, info.isLike ]);
  }
  else if (userLike[0].like)
  {
    console.log("isNotLike");
    // The user unliked the video.
    const sql = 'UPDATE video_likes SET video_likes.like = false WHERE video_likes.video_id = ? AND video_likes.user_id = ?';
    await connection.promise().query(sql, [ info.videoID, info.userID ]);
  }
  else
  {
    console.log("isLike");
    const sql = 'UPDATE video_likes SET video_likes.like = true WHERE video_likes.video_id = ? AND video_likes.user_id = ?';
    await connection.promise().query(sql, [ info.videoID, info.userID ]);
  }
  
  connection.end();
}


async function handleVideoLikeCount(info) {
  // Data expiry time. 
  // After the interval, the value will get updated.
  const expiryTime = 5;

  // Check whether there is a value cached in the redis.
  const videoKey = info.videoKey+'-like-key';
  var value = await redisClient.get(videoKey);
  
  if (value == null) {
    value = await getLikeCount(info.videoID);
    await redisClient.set(videoKey, value, { EX: 2 });
    await handleVideoLikeCount(info);
    return;
  }

  console.log("Sending back like count:", value);
  
  const room = info.videoKey+'room';
  io.to(room).emit("like", { 'room':room, 'value':value });
}

io.on("connection", (socket) => {
  // Client requesting for view count of a particular video.
  socket.on("video", (info) => handleVideo(socket, info));
  socket.on('getNewViewCount', (info) => handleVideoViewCount(info));
  socket.on('getNewLikeCount', (info) => handleVideoLikeCount(info));
  socket.on('videoLikeToggle', (info) => handleVideoLikeToggle(info));
});

console.log("Started server on port 5001.");
httpServer.listen(5001);