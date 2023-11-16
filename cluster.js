import cluster from "node:cluster";
import http from "http";
import { setupMaster } from "@socket.io/sticky";

const WORKERS_COUNT = 4;

if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  for (let i = 0; i < WORKERS_COUNT; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork();
  });

  const httpServer = http.createServer();
  setupMaster(httpServer, {
    // loadBalancingMethod: "least-connection", // either "random", "round-robin" or "least-connection"
    loadBalancingMethod: "round-robin", // either "random", "round-robin" or "least-connection"
  });
  const PORT = process.env.PORT || 5001;

  httpServer.listen(PORT, () =>
    console.log(`server listening at http://localhost:${PORT}`)
  );
} else {
  console.log(`Worker ${process.pid} started`);
  // import("./index.js");
}
