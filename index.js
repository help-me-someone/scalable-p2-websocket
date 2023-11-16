/**
 * Required ENV.
 * - CORS_ORIGIN
 * - REDIS_IP
 * - MYSQL_IP
 * - MYSQL_HOST
 * - DB_USERNAME
 * - DB_PASSWORD
 */

import { createServer } from "http"; 
import { Server } from "socket.io";
import { createClient } from 'redis';
import { createConnection } from 'mysql2';
import { setupWorker } from '@socket.io/sticky';
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from 'ioredis';

const redisUrl = `redis://${process.env.REDIS_IP}/5`

const serverRedisClient = new Redis(redisUrl);
const redisClient = createClient({ url: redisUrl });

// TODO: Move this into multiple files later for better organization.
console.log("ALLOWED_ORIGIN", process.env.ALLOWED_ORIGIN);
console.log("REDIS_IP", process.env.REDIS_IP);
console.log("DB_IP", process.env.DB_IP);
console.log("DB_HOST", process.env.DB_HOST);
console.log("DB_USERNAME", process.env.DB_USERNAME);
console.log("DB_PASSWORD", process.env.DB_PASSWORD);

// Set up redis client.

redisClient.on('error', err => console.log('Redis Client Error', err))
await redisClient.connect()

const httpServer = createServer();
const io = new Server(httpServer, { 
    cors: {
      origin: process.env.ALLOWED_ORIGIN,
    },
 });

io.adapter(createAdapter(serverRedisClient, serverRedisClient.duplicate()));
setupWorker(io);

async function getMySQLConnection() {
  var mySqlClient = createConnection(`mysql://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_IP}/toktik-db?charset=utf8mb4&parseTime=True&loc=Local`);

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

async function createNotification(connection, videoID, actorID, userID, notifType, date) {
    const sql = 'INSERT INTO video_notifications(video_notifications.video_id, video_notifications.actor_id, video_notifications.user_id, video_notifications.read, video_notifications.type, video_notifications.date) VALUES (?, ?, ?, ?, ?, ?)';
    const res = await connection.promise().query(sql, [ videoID, actorID, userID, false, notifType, date ]);
    return res[0].insertId
}

async function getNotificationParticipants(connection, videoID) {

  // // Get the like count.
	const sql = `
		SELECT DISTINCT user_id
		FROM video_likes
		WHERE video_likes.video_id = ? AND video_likes.like = true
		UNION
		SELECT DISTINCT user_id
		FROM video_comments
		WHERE video_comments.video_id = ?
	`
  const results = await connection.promise().query(sql, [videoID, videoID])
 
  return results[0];  
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

  // console.log("Socket joined room:", info.video+'room');

  // Serve the view count.
  handleVideoViewCount(socket, info);
}

// Input:
// - socket
// - info -> { room }
async function handleJoin(socket, info) {
  socket.join(info.room);
}

async function handleVideoViewCount(socket, info) {
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
  
  // console.log("Value: ", value);
  const target = (info.to=='user') ? socket : io.to(info.video+'room');
  
  target.emit("update", { 'room':info.video, 'value':value });
}

// INPUT
// - INFO
//   - owner_username : The username of the owner of the video.
//   - videoname      : The video's name.
//   - video_key      : The video's key.
//   - vid            : The video's ID.
//   - uid            : The actor's user ID.
//   - type           : The type of notification.
//   - date           : The time when the notification is sent out.
async function createVideoNotification(connection, info) {

  // Get the video and it's owner.
  const video = await getVideo(connection, info.vid);
  const videoOwner = await getUser(connection, video.user_id);
  
  // Get the actor.
  const actor = await getUser(connection, info.uid); 
  const actorUsername = actor.username;

  // Get the action.
  const action = (info.type=="comment") ? "commented on video" : "liked video";

  // Not ideal, very dumb, but will work.
  const actionCode = (info.type=="comment") ? 1 : 0;
  
  // Collect all participants and notify all of them.
  const participants = await getNotificationParticipants(connection, info.vid);
  await Promise.all(
    participants.filter(p => p.user_id != info.uid).map(async (p) => {
      const user = await getUser(connection, p.user_id);
      const username = user.username;
      const actionMessage = `${actorUsername} ${action} '${video.name}'`
      
      // Create the actual database record.
      const notifID = await createNotification(connection, info.vid, info.uid, user.id, actionCode, info.date);

      const message = {
        username: actorUsername,
        videoname: video.name,
        videoOwner: videoOwner.username,
        videoKey: video.key,
        message: actionMessage,
        id: notifID,
      };

      // console.log("Sending notif: ", username, message.message);
      io.to(username).emit("updateNotifications", {count: 1, notifications: [message]});
    })
  );
}

async function handleVideoLikeToggle(info) {
  const connection = await getMySQLConnection();
  const userLike = await getUserLike(info.videoID, info.userID);

  // console.log(userLike);

  if (userLike.length == 0) 
  {
    // The user's like entry does not exist in the database. Let's change that.
    const sql = 'INSERT INTO video_likes(video_id, user_id, video_likes.like) VALUES (?, ?, ?)';
    await connection.promise().query(sql, [ info.videoID, info.userID, info.isLike ]);
    const date = new Date();
    
    await createVideoNotification(connection, {
      vid  : info.videoID,
      uid  : info.userID,
      type : "like",
      date : date,
    });
  }
  else if (userLike[0].like)
  {
    // The user unliked the video.
    const sql = 'UPDATE video_likes SET video_likes.like = false WHERE video_likes.video_id = ? AND video_likes.user_id = ?';
    await connection.promise().query(sql, [ info.videoID, info.userID ]);
  }
  else
  {
    const sql = 'UPDATE video_likes SET video_likes.like = true WHERE video_likes.video_id = ? AND video_likes.user_id = ?';
    await connection.promise().query(sql, [ info.videoID, info.userID ]);
  }
  
  connection.end();
}

async function handleVideoLikeCount(socket, info) {
  // Data expiry time. 
  // After the interval, the value will get updated.
  const expiryTime = 5;

  // Check whether there is a value cached in the redis.
  const videoKey = info.videoKey+'-like-key';
  var value = await redisClient.get(videoKey);
  
  if (value == null) {
    value = await getLikeCount(info.videoID);
    await redisClient.set(videoKey, value, { EX: 2 });
    await handleVideoLikeCount(socket, info);
    return;
  }
  const room = info.videoKey+'room';
  const target = (info.to=='user') ? socket : io.to(room);
  target.emit("like", { 'key':info.videoKey, 'room':room, 'value':value });
}

async function getUser(connection, uid) {
  const sql = "SELECT * FROM users WHERE users.ID = ?"
  const results = await connection.promise().query(sql, [uid])
  return results[0][0]
}

async function getNotification(connection, uid, vid, date) {
  const sql = `
    SELECT * 
    FROM video_notifications
    WHERE video_notifications.user_id = ${uid} AND video_notifications.video_id = ${vid} AND video_notifications.date >= '${date}' 
    LIMIT 1
  `

  // console.log("SQL:", sql);
  
  // ORDER BY video_notifications.id ASC 
  const results = await connection.promise().query(sql)
  // console.log("Got notification:", results[0]);
  return results[0][0]
}

async function getVideo(connection, vid) {
  const sql = "SELECT * FROM videos WHERE videos.ID = ?"
  const results = await connection.promise().query(sql, [vid])
  return results[0][0]
}

async function getUserFromUsername(connection, username) {
  const sql = "SELECT * FROM users WHERE users.username = ?"
  const results = await connection.promise().query(sql, [username])
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

  // console.log("HandleVideoComment, videoID: ", info.videoID);

  // Check whether there is a value cached in the redis.
  const videoKey = info.videoKey+'-comment-key';
  var value = await redisClient.get(videoKey);

  // console.log("Print handleVideoComment value: ", value);
  
  if (value == null) {
    value = await getVideoComments(info.videoID);
    // console.log("Print handleVideoComment FROM DB value: ", value);
    
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

    // console.log("Comment Value: ", value);
    
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
  io.to(info.room).emit("comment", { 'room':info.room, 'value': JSON.stringify([commentData]) });
}

// Input:
// - socket
// - info -> { uid, vid }
//
// Output:
// - notifs -> { count, notifications }
async function handleReadNotification(socket, info) {
    const connection = await getMySQLConnection();
    const sql = 'UPDATE video_notifications SET video_notifications.read = true WHERE video_notifications.id = ?';
    await connection.promise().query(sql, [ info.id ]);
    connection.end();
}

async function processNotification(connection, notif) {
    // console.log("Notif: ", notif);
    const user = await getUser(connection, notif.actor_id);
    const video = await getVideo(connection, notif.video_id);
    const videoOwner = await getUser(connection, video.user_id)

    // console.log("Video: ", video);
    // console.log("VideoOwner: ", videoOwner);
    
    const action = (notif.type == 1) ? " commented on video '" : " liked video '";
    const notifMessage = user.username + action + video.name + "'";
    
    return {
      id: notif.id,
      username: user.username,
      videoname: video.name,
      videoOwner: videoOwner.username,
      videoKey: video.key,
      message: notifMessage,
      read: notif.read,
    }
}

// Input:
// - socket
// - info -> { username }
//
// Output:
// - notifs -> { count, notifications }
async function handleGetNotifications(socket, info) {
  const connection = await getMySQLConnection();
  const username = info.username;
  const user = await getUserFromUsername(connection, username);
  
  // console.log("user: ", user);
  
  const sql = 'SELECT * FROM video_notifications WHERE video_notifications.user_id = ?';
  const result = await connection.promise().query(sql, [ user.id ]);

  // Array of notif objects.
  const notifs = result[0].filter(n => n.actor_id != n.user_id);
  
  // console.log("Notif: ", notifs);

  const processedNotifs = await Promise.all(
    notifs.map(async (notif) => processNotification(connection, notif))
  );

  // console.log("Processed Notifs: ", processedNotifs);
  
  const message = { count: notifs.filter(x => !x.read).length, notifications: processedNotifs };
  
  connection.end();

  // io.to(username).emit("updateNotifications", message);
  socket.emit("updateNotifications", message);
}

// Input
// - socket
// - info -> {
//     username,
//     videoname,
//     owner_username,
//     video_key,
//     message,
//   }
async function handlePushNotification(socket, info) {
  const connection = await getMySQLConnection();

  // console.log("Notif date: ", info.date);

  // Get the current user.
  const actor = await getUser(connection, info.uid); 
  const actorUsername = actor.username;
  const action = (info.type=="comment") ? "commented on video" : "liked video"
  const participants = await getNotificationParticipants(connection, info.vid);
  
  await Promise.all(
    participants.filter(p => p.user_id != info.uid).map(async (p) => {
      const user = await getUser(connection, p.user_id);
      const username = user.username;
      const actionMessage = `${actorUsername} ${action} '${info.videoname}'`
      const notif = await getNotification(connection, p.user_id, info.vid, info.date);
      const notifID = notif.id;
      
      const message = {
        username: actorUsername,
        videoname: info.videoname,
        videoOwner: info.owner_username,
        videoKey: info.video_key,
        message: actionMessage,
        id: notifID,
      };

      // console.log("Sending notif: ", username, message);
      io.to(username).emit("updateNotifications", {count: 1, notifications: [message]});
    })
  );
  
  connection.end();
}

io.on("connection", (socket) => {
  console.log("Connected: ", process.pid);
  
  // Client requesting for view count of a particular video.
  socket.on("video", (info) => handleVideo(socket, info));
  socket.on("join", (info) => handleJoin(socket, info));
  socket.on('getNewViewCount', (info) => handleVideoViewCount(socket, info));
  socket.on('getNewLikeCount', (info) => handleVideoLikeCount(socket, info));
  socket.on('getVideoComments', (info) => handleVideoGetComment(socket, info));
  socket.on('getNotifications', (info) => handleGetNotifications(socket, info));
  
  socket.on('pushNotification', (info) => handlePushNotification(socket, info));
  
  socket.on('videoLikeToggle', (info) => handleVideoLikeToggle(info));
  socket.on('newComment', (info) => handleNewComment(socket, info));
  socket.on("readNotification", (info) => handleReadNotification(socket, info));
});

