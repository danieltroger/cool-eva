import { createHash } from "node:crypto";
import { appendFile, copyFile, lstat, readFile, readlink, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

async function main(): Promise<void> {
  const command = process.argv[2];
  const arguments_ = process.argv.slice(3);
  const root = process.env.UPDATE_FIXTURE;
  if (!root) {
    throw new Error("No updater fixture root");
  }
  await appendFile(join(root, "commands.txt"), `${command} ${arguments_.join(" ")}\n`);
  if (command === "id") {
    console.log("0");
  } else if (command === "stat") {
    const metadata = await lstat(arguments_.at(-1)!);
    console.log(`0:${(metadata.mode & 0o777).toString(8)}`);
  } else if (command === "mv") {
    await rename(arguments_.at(-2)!, arguments_.at(-1)!);
  } else if (command === "readlink" && !arguments_.includes("-f")) {
    console.log(await readlink(arguments_.at(-1)!));
  } else if (command === "realpath" || command === "readlink") {
    console.log(await realpath(arguments_.at(-1)!));
  } else if (command === "cut") {
    const clockFile = join(root, "clock.txt");
    const seconds = Number(await readFile(clockFile, "utf8")) + 30;
    await writeFile(clockFile, String(seconds));
    console.log(seconds);
  } else if (command === "systemctl") {
    await systemControl(root, arguments_);
  } else if (command === "curl") {
    await download(root, arguments_);
  } else if (command === "sha256sum") {
    await verifyChecksums(arguments_);
  } else if (command === "fixture-node") {
    if (arguments_[2] === "settings") {
      const metadata: { readableSchemas: number[] } = JSON.parse(
        await readFile(join(resolve(dirname(arguments_[1]), "../.."), "release.json"), "utf8")
      );
      const settings: { schemaVersion: number; migration: { complete: boolean } } = JSON.parse(
        await readFile(arguments_[3], "utf8")
      );
      if (!metadata.readableSchemas.includes(settings.schemaVersion) || !settings.migration.complete) {
        process.exitCode = 1;
      }
    }
  } else if (!["sleep", "sync", "flock"].includes(command)) {
    throw new Error(`Unknown fixture command ${command}`);
  }
}

async function systemControl(root: string, arguments_: string[]): Promise<void> {
  if (arguments_[0] === "show") {
    const property = arguments_.find(argument => argument.startsWith("--property="))?.split("=")[1];
    console.log((await readFile(join(root, `${property}.txt`), "utf8")).trim());
  }
}

async function download(root: string, arguments_: string[]): Promise<void> {
  const url = arguments_.at(-1)!;
  if (url.startsWith("http://127.0.0.1")) {
    if (process.env.UPDATE_FIXTURE_REAL_HEALTH === "1") {
      const dataIndex = arguments_.indexOf("--data");
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
        ...(dataIndex >= 0
          ? {
              method: "POST",
              headers: { "X-Cool-Eva": "update", "Content-Type": "application/json" },
              body: arguments_[dataIndex + 1],
            }
          : {}),
      });
      if (!response.ok) {
        process.exitCode = 22;
      }
      if (response.ok || arguments_.includes("--fail-with-body")) {
        process.stdout.write(await response.text());
      }
      return;
    }
    const output = url.endsWith("/update/reserve-stop")
      ? await readFile(join(root, "stop-admission.txt"), "utf8")
      : url.endsWith("/settings")
        ? JSON.stringify({ processGeneration: "synthetic-process", revision: 0 })
        : await readFile(join(root, "health.txt"), "utf8");
    if (output === "fail") {
      process.exitCode = 22;
    } else {
      process.stdout.write(output);
    }
    return;
  }
  const filename = basename(url);
  const tag = url.split("/").at(-2)!;
  const outputIndex = arguments_.indexOf("--output");
  await copyFile(join(root, "assets", tag, filename), arguments_[outputIndex + 1]);
}

async function verifyChecksums(arguments_: string[]): Promise<void> {
  if (!arguments_.some(argument => argument === "-c" || argument === "--check")) {
    for (const filename of arguments_) {
      console.log(
        `${createHash("sha256")
          .update(await readFile(filename))
          .digest("hex")}  ${filename}`
      );
    }
    return;
  }
  const inventory = arguments_.at(-1) === "-" ? await standardInput() : await readFile(arguments_.at(-1)!, "utf8");
  for (const line of inventory.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) {
      process.exitCode = 1;
      return;
    }
    try {
      const digest = createHash("sha256")
        .update(await readFile(match[2]))
        .digest("hex");
      if (digest !== match[1]) {
        console.log(`${match[2]}: FAILED`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.log(`${match[2]}: FAILED open or read`);
      console.warn("fixture checksum could not read:", error);
      process.exitCode = 1;
    }
  }
}

async function standardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

await main();
