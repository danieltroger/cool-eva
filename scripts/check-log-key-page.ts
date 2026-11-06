import assert from "node:assert/strict";
import { generateLogKeyPair } from "../workers/keys/public/key-crypto.js";
import { checkKeyEncoding, checkLogKeyRoundTrip } from "./log-key-roundtrip.ts";

const firstPair = await generateLogKeyPair();
const nextPair = await generateLogKeyPair();
checkKeyEncoding(nextPair);
assert.notEqual(firstPair.publicPem, nextPair.publicPem, "explicit generations must create fresh keys");
await checkLogKeyRoundTrip(firstPair);
console.log(
  "✓ browser WebCrypto exports match Node PEM bytes; production .celog sealing/decrypt CLI restores synthetic readings; wrong key refused"
);
