import {
  Direction,
  FrameAssembler,
  MessageKind,
  clearEnvelope,
  decodeMessage,
  deriveSessionKey,
  encodeMessage,
  helloProof,
  openEnvelope,
  parseEnvelope,
  proofsMatch,
  randomNonce,
  sealEnvelope,
  splitIntoFrames,
} from "../public/lib/ble-wire.js";

// The BLE GATT wire format (public/lib/ble-wire.js), shared by the dashboard and the Pi.
// No radio, no D-Bus: bytes in, bytes out.
//
//   node --experimental-strip-types scripts/check-ble-wire.ts
//
// Run by `npm test` via scripts/run-checks.ts. docs/ble-server.md has the protocol.

const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  if (!condition) {
    failures.push(description);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function patterned(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * 31 + 7) & 0xff;
  }
  return bytes;
}

// §1 Frames round-trip at every MTU a phone is likely to negotiate, across lengths that
// land exactly on, one under and one over a frame boundary.
for (const frameBytes of [20, 182, 244, 512]) {
  for (const length of [0, 1, frameBytes - 2, frameBytes - 1, frameBytes, 3 * (frameBytes - 2) + 1, 40_000]) {
    const envelope = patterned(length);
    const frames = splitIntoFrames(envelope, 9, frameBytes);
    expect(
      frames.every(frame => frame.length <= frameBytes),
      `§1 a frame exceeded ${frameBytes} bytes at length ${length}`
    );
    const assembler = new FrameAssembler(1_000_000);
    let reassembled: Uint8Array | undefined;
    for (const frame of frames) {
      const result = assembler.push(frame);
      expect(result.problem === undefined, `§1 unexpected problem at ${frameBytes}/${length}: ${result.problem}`);
      if (result.envelope) {
        reassembled = result.envelope;
      }
    }
    expect(
      reassembled !== undefined && equalBytes(reassembled, envelope),
      `§1 round-trip failed at frame ${frameBytes}, length ${length}`
    );
  }
}

// §2 A message cut short is reported, and the one after it still arrives intact.
{
  const assembler = new FrameAssembler(1_000_000);
  const first = splitIntoFrames(patterned(100), 1, 20);
  const second = splitIntoFrames(patterned(50), 2, 20);
  for (const frame of first.slice(0, -1)) {
    assembler.push(frame);
  }
  const problems: string[] = [];
  let delivered: Uint8Array | undefined;
  for (const frame of second) {
    const result = assembler.push(frame);
    if (result.problem) {
      problems.push(result.problem);
    }
    if (result.envelope) {
      delivered = result.envelope;
    }
  }
  expect(problems.length === 1, `§2 expected one abandoned-message problem, got ${problems.length}`);
  expect(delivered !== undefined && equalBytes(delivered, patterned(50)), "§2 the following message was lost");
}

// §3 An oversized message is refused rather than buffered without limit.
{
  const assembler = new FrameAssembler(100);
  const results = splitIntoFrames(patterned(500), 3, 64).map(frame => assembler.push(frame));
  expect(
    results.some(result => result.problem?.includes("exceeds")),
    "§3 a message over the cap was not refused"
  );
  expect(
    results.every(result => result.envelope === undefined),
    "§3 an oversized message was delivered"
  );
}

// §4 Messages carry kind, JSON header and binary body unchanged.
{
  const body = patterned(300);
  const header = { id: 7, method: "POST", path: "/vcu-write?x=1", headers: { "x-cool-eva": "service-write" } };
  const decoded = decodeMessage(encodeMessage(MessageKind.REQUEST, header, body));
  expect(decoded.kind === MessageKind.REQUEST, "§4 kind changed");
  expect(JSON.stringify(decoded.header) === JSON.stringify(header), "§4 header changed");
  expect(equalBytes(decoded.body, body), "§4 body changed");
}

// §5 The handshake: matching secrets agree on a proof and a key; a wrong secret does not,
// and a sealed envelope opened with the wrong key, the wrong direction, a different
// counter or one flipped bit is rejected.
{
  const serverNonce = randomNonce();
  const clientNonce = randomNonce();
  const proof = await helloProof("correct horse battery staple", serverNonce, clientNonce);
  const sameProof = await helloProof("correct horse battery staple", serverNonce, clientNonce);
  const wrongProof = await helloProof("wrong secret", serverNonce, clientNonce);
  const otherNonceProof = await helloProof("correct horse battery staple", randomNonce(), clientNonce);
  expect(proofsMatch(proof, sameProof), "§5 the same secret produced different proofs");
  expect(!proofsMatch(proof, wrongProof), "§5 a wrong secret produced a matching proof");
  expect(!proofsMatch(proof, otherNonceProof), "§5 a proof survived a server nonce rotation");

  const key = await deriveSessionKey("correct horse battery staple", serverNonce, clientNonce);
  const wrongKey = await deriveSessionKey("wrong secret", serverNonce, clientNonce);
  const message = encodeMessage(MessageKind.STREAM, { type: "snapshot", ts: 1, signals: {} });
  const sealed = await sealEnvelope(key, Direction.TO_PHONE, 41, message);
  const parsed = parseEnvelope(sealed);
  expect(parsed.sealed && parsed.counter === 41, "§5 counter did not survive the envelope");
  if (parsed.sealed) {
    const opened = await openEnvelope(key, Direction.TO_PHONE, parsed.counter, parsed.ciphertext);
    expect(equalBytes(opened, message), "§5 sealed message did not open to itself");

    const rejections: [string, () => Promise<unknown>][] = [
      ["wrong key", () => openEnvelope(wrongKey, Direction.TO_PHONE, parsed.counter, parsed.ciphertext)],
      ["wrong direction", () => openEnvelope(key, Direction.TO_PI, parsed.counter, parsed.ciphertext)],
      ["wrong counter", () => openEnvelope(key, Direction.TO_PHONE, parsed.counter + 1, parsed.ciphertext)],
      [
        "flipped bit",
        () => {
          const tampered = parsed.ciphertext.slice();
          tampered[0] ^= 1;
          return openEnvelope(key, Direction.TO_PHONE, parsed.counter, tampered);
        },
      ],
    ];
    for (const [label, attempt] of rejections) {
      const outcome = await attempt().then(
        () => "opened",
        () => "rejected"
      );
      expect(outcome === "rejected", `§5 ${label}: envelope ${outcome}`);
    }
  }

  const clear = parseEnvelope(clearEnvelope(message));
  expect(!clear.sealed && equalBytes(clear.message, message), "§5 clear envelope did not round-trip");
}

// §6 Compression earns its place on telemetry-shaped JSON. Not a performance budget —
// a guard against the compression step quietly becoming a no-op.
{
  const signals: Record<string, { value: number; unit: string; group: string; ts: number }> = {};
  for (let index = 0; index < 300; index++) {
    signals[`signal_${index}`] = { value: index * 1.5, unit: "°C", group: "thermal", ts: 1_760_000_000_000 + index };
  }
  const message = encodeMessage(MessageKind.STREAM, { type: "snapshot", ts: 1, signals });
  const key = await deriveSessionKey("secret", randomNonce(), randomNonce());
  const sealed = await sealEnvelope(key, Direction.TO_PHONE, 0, message);
  expect(sealed.length * 3 < message.length, `§6 a ${message.length}-byte snapshot only sealed to ${sealed.length}`);
}

if (failures.length > 0) {
  console.error(`check-ble-wire: ${failures.length} failure(s)`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log("check-ble-wire: all checks passed");
