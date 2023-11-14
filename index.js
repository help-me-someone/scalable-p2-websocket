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

async function getVideoComments(videoID) {
  const connection = await getMySQLConnection();

  // // Get the like count.
  const sql = 'SELECT * FROM video_comments WHERE video_comments.video_id = ? ORDER BY video_comments.date ASC';
  const results = await connection.promise().query(sql, [videoID])
  connection.end();
 
  return results[0];  
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

// videoID
// userID
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

async function getUser(connection, uid) {
  const sql = "SELECT * FROM users WHERE users.ID = ?"
  const results = await connection.promise().query(sql, [uid])
  return results[0][0]
}

function makePrettyDate(date) {
  const month = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dateString = month[date.getMonth()].slice(0, 3) + ' ' + date.getDate() + ', ' + date.getFullYear() + ' at ' + date.toLocaleTimeString('en-US', { hour12: false, hour: "numeric", minute: "numeric"});
  return dateString;
}

async function handleVideoGetComment(socket, info) {
  // Data expiry time. 
  // After the interval, the value will get updated.
  const expiryTime = 5;

  console.log("HandleVideoComment, videoID: ", info.videoID);

  // Check whether there is a value cached in the redis.
  const videoKey = info.videoKey+'-comment-key';
  var value = await redisClient.get(videoKey);

  console.log("Print handleVideoComment value: ", value);
  
  if (value == null) {
    value = await getVideoComments(info.videoID);
    console.log("Print handleVideoComment FROM DB value: ", value);
    
    const connection = await getMySQLConnection();
    
    const newValue = await Promise.all(
      value.map(async (comment) => {
        const user = await getUser(connection, comment.user_id);
        const dateString = makePrettyDate(new Date(comment.date))
        
        return {
          user: user.username,
          comment: comment.comment,
          date: dateString,
        }
      })
    )
    
    connection.end();

    value = JSON.stringify(newValue);

    console.log("Comment Value: ", value);
    
    await redisClient.set(videoKey, value, { EX: 2 });
  }

  const room = info.videoKey+'room';
  socket.emit("comment", { 'room':room, 'value':value });
}

async function handleNewComment(socket, info) {
  const connection = await getMySQLConnection();

  const user = await getUser(connection, info.user_id);
  const dateString = makePrettyDate(new Date(info.date))
  const commentData = {
    user: user.username,
    comment: info.comment,
    date: dateString,
  }
  connection.end();
  console.log("CommentData:", commentData);
  io.to(info.room).emit("comment", { 'room':info.room, 'value': JSON.stringify([commentData]) });
}

io.on("connection", (socket) => {
  // Client requesting for view count of a particular video.
  socket.on("video", (info) => handleVideo(socket, info));
  socket.on('getNewViewCount', (info) => handleVideoViewCount(info));
  socket.on('getNewLikeCount', (info) => handleVideoLikeCount(info));
  socket.on('getVideoComments', (info) => handleVideoGetComment(socket, info));
  
  socket.on('videoLikeToggle', (info) => handleVideoLikeToggle(info));
  socket.on('newComment', (info) => handleNewComment(socket, info));
});

console.log("Started server on port 5001.");
httpServer.listen(5001);