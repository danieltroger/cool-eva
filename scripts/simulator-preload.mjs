import childProcess from "node:child_process";
import filesystem from "node:fs";
import promises from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const logPath = process.env.COOL_EVA_SIMULATOR_FENCE_LOG;
if (!logPath) throw new Error("Simulator proof needs its own audit log.");
const append = promises.appendFile.bind(promises);
let writing = Promise.resolve();
const replayAt = process.argv.indexOf("--replay");
const capture = resolve(process.argv[replayAt + 1]);
const root = resolve(process.argv[replayAt + 2]);
const code = dirname(dirname(fileURLToPath(import.meta.url)));
const forbidden = new Set(["socketcan", "max31865", "spi-device"]);

function record(event) {
  writing = writing
    .then(() => append(logPath, JSON.stringify({ pid: process.pid, ...event }) + "\n"))
    .catch(error => {
      console.error("simulator proof: cannot write audit log", error);
      process.exitCode = 1;
    });
}

registerHooks({
  resolve(specifier, context, next) {
    if (forbidden.has(specifier)) {
      record({ type: "denied-import", specifier });
      throw new Error(`Simulator proof blocked native import ${specifier}`);
    }
    return next(specifier, context);
  },
});

function allowedCommand(command, arguments_) {
  if (command === "git") {
    return (
      arguments_[0] === "-C" &&
      resolve(arguments_[1]) === code &&
      (JSON.stringify(arguments_.slice(2)) === '["rev-parse","--short","HEAD"]' ||
        JSON.stringify(arguments_.slice(2)) === '["status","--porcelain","--untracked-files=no"]')
    );
  }
  return (
    command === process.execPath &&
    arguments_[0] === "--input-type=module" &&
    arguments_[1] === "--eval" &&
    arguments_[2]?.includes('process.stdout.write("cool-eva-settings-lock\\n")') &&
    arguments_[3] === "--" &&
    arguments_.includes(root + "/state/settings.lock")
  );
}

for (const name of ["spawn", "execFile", "exec"]) {
  const original = childProcess[name];
  const wrapped = function (command, ...arguments_) {
    const argv = Array.isArray(arguments_[0]) ? arguments_[0] : [];
    const allowed = name !== "exec" && allowedCommand(command, argv);
    record({ type: allowed ? "command" : "denied-command", method: name, command, arguments: argv });
    if (!allowed) throw new Error(`Simulator proof blocked ${name} ${command}`);
    const child = original.call(childProcess, command, ...arguments_);
    if (command === process.execPath) record({ type: "holder", holderPid: child.pid });
    return child;
  };
  if (name === "execFile") {
    wrapped[promisify.custom] = (command, ...arguments_) =>
      new Promise((resolveReply, reject) => {
        wrapped(command, ...arguments_, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolveReply({ stdout, stderr });
        });
      });
  }
  childProcess[name] = wrapped;
}

function contained(path, directory) {
  return path === directory || path.startsWith(directory + sep);
}

function checkPath(value, write) {
  if (typeof value === "number") return;
  const path = resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  const oldState = ["ride-logs", "vcu-params", "wifi-diag", "captures", "data"].some(name =>
    contained(path, resolve(code, name))
  );
  const allowed = contained(path, root) || (!write && (path === capture || (contained(path, code) && !oldState)));
  if (!allowed) {
    record({ type: "denied-file", path, write });
    throw new Error(`Simulator proof blocked ${write ? "write" : "read"} outside scratch/code/input: ${path}`);
  }
}

for (const api of [filesystem, promises]) {
  for (const name of ["readFile", "stat", "lstat", "statfs", "readdir", "access", "readlink", "realpath"]) {
    const original = api[name];
    api[name] = function (path, ...arguments_) {
      checkPath(path, false);
      return original.call(api, path, ...arguments_);
    };
  }
  for (const name of ["writeFile", "appendFile", "mkdir", "unlink", "rm", "rmdir", "chmod", "chown", "truncate"]) {
    const original = api[name];
    api[name] = function (path, ...arguments_) {
      checkPath(path, true);
      return original.call(api, path, ...arguments_);
    };
  }
  for (const name of ["rename", "copyFile", "link", "symlink"]) {
    const original = api[name];
    api[name] = function (from, to, ...arguments_) {
      checkPath(from, true);
      checkPath(to, true);
      return original.call(api, from, to, ...arguments_);
    };
  }
  const open = api.open;
  api.open = function (path, flags, ...arguments_) {
    const write = typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & 3) !== 0;
    checkPath(path, write);
    return open.call(api, path, flags, ...arguments_);
  };
}

const readStream = filesystem.createReadStream;
filesystem.createReadStream = function (path, ...arguments_) {
  checkPath(path, false);
  return readStream.call(filesystem, path, ...arguments_);
};
const writeStream = filesystem.createWriteStream;
filesystem.createWriteStream = function (path, ...arguments_) {
  checkPath(path, true);
  return writeStream.call(filesystem, path, ...arguments_);
};

// The app uses ESM named imports, including execFile captured by promisify at module load.
syncBuiltinESMExports();
