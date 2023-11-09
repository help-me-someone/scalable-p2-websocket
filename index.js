const { createServer } = require("http");
const { Server } = require("socket.io");

const httpServer = createServer();
const io = new Server(httpServer, { 
    cors: {
      origin: "http://localhost:8000",
    },
 });

io.on("connection", (socket) => {
  console.log('Got connection!');
});

console.log("Started server on port 5001.");
httpServer.listen(5001);