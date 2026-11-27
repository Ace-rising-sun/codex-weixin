import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isWindows, socketFor } from "../runtime/platform.mjs";
export function testControl(home, action, data = {}) {
  const headers = {};
  if (isWindows) {
    try {
      headers.Authorization =
        "Bearer " +
        JSON.parse(readFileSync(join(home, "control.json"), "utf8")).key;
    } catch {}
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socketFor(home),
        path: "/" + action,
        method: "POST",
        headers,
      },
      (response) => {
        response.setEncoding("utf8");
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(data));
  });
}
