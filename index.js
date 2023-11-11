import { createServer } from "http";
import { Server } from "socket.io";
import { createClient } from 'redis';

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

var viewCountFromDatabase = 5;

async function handleVideo(socket, info) {
  socket.join(info.video+'room');
  viewCountFromDatabase++;
  handleVideoViewCount(info);
}

async function handleVideoViewCount(info) {
  console.log("Handling get new view count");
  
  // Data expiry time. 
  // After the interval, the value will get updated.
  const expiryTime = 5;

  // Check whether there is a value cached in the redis.
  const videoKey = info.video+'key';
  var value = await redisClient.get(videoKey);
  if (value == null) {
    await redisClient.set(videoKey, viewCountFromDatabase, { EX: expiryTime });
    console.log('Setting a value on the redis cache from db, value');
    value = viewCountFromDatabase;
  }
  else {
    console.log('Got value from cache');
  }
  
  io.to(info.video+'room').emit("update", value);
}

io.on("connection", (socket) => {
  // Client requesting for view count of a particular video.
  socket.on("video", (info) => handleVideo(socket, info));
  socket.on('getNewViewCount', (info) => handleVideoViewCount(info));
});

console.log("Started server on port 5001.");
httpServer.listen(5001);