import http from "node:http";
import handler from "./api/[...path].mjs";

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => handler(req, res));
server.listen(port, () => console.log("Creator OS listening on http://localhost:" + port));
