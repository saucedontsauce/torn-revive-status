const fs = require("fs");

const source = fs.readFileSync("script.js", "utf8");

const match = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);

if (!match) {
  throw new Error("Metadata block not found");
}

fs.mkdirSync("dist", { recursive: true });

fs.writeFileSync("dist/script.user.js", source);
fs.writeFileSync("dist/script.meta.js", match[0] + "\n");

console.log("Built script.user.js and script.meta.js");
