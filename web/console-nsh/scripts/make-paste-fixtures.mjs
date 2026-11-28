// Writes the large pasted-image fixture of tests/chat-image-paste-web.test.tsx (FT197): a valid
// 19 MiB PNG (tests/fixtures/paste/red.png with a private ancillary chunk of padding, which
// decoders skip), into tests/fixtures/paste/large/, which git ignores. scripts/test.sh runs this
// first; run it by hand before running that test file alone. The same bytes every time.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { crc32 } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 19 * 1024 * 1024;
const out = join(app, "tests/fixtures/paste/large/photo-19MiB.png");
if (existsSync(out) && statSync(out).size === SIZE) process.exit(0);

const small = readFileSync(join(app, "tests/fixtures/paste/red.png"));
const iend = small.subarray(small.length - 12);
const body = small.subarray(0, small.length - 12);
const data = Buffer.alloc(SIZE - small.length - 12);
for (let i = 0; i < data.length; i++) data[i] = 97 + (i % 26);
const type = Buffer.from("ftPd");
const head = Buffer.alloc(8);
head.writeUInt32BE(data.length, 0);
type.copy(head, 4);
const crc = Buffer.alloc(4);
crc.writeUInt32BE(crc32(data, crc32(type)) >>> 0, 0);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([body, head, data, crc, iend]));
if (statSync(out).size !== SIZE) throw new Error("wrong size");
