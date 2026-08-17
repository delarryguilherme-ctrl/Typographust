/** Round-trip check for the hand-rolled ZIP writer. Read back with any unzipper. */
import { readFileSync, writeFileSync } from "node:fs";
import { buildZip } from "../lib/font/zip";

const payload = new Uint8Array(readFileSync(process.argv[2]));
const zip = buildZip([
  { name: "SmokeTest-Bold.ttf", data: payload },
  { name: "notes/readme.txt", data: new TextEncoder().encode("hello zip") },
]);
writeFileSync(process.argv[3], zip);
console.log(`zip ${zip.length} bytes for a ${payload.length} byte payload`);
