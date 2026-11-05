import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function runInTerminal(
  executable: string,
  arguments_: string[],
  answers: [string, string][],
  environment = process.env,
  timeout = 20_000
): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    "python3",
    [fileURLToPath(new URL("./pty-driver.py", import.meta.url)), executable, ...arguments_],
    {
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      env: environment,
    }
  );
  let output = "";
  let scanned = 0;
  let next = 0;
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
    if (answers[next] && output.slice(scanned).includes(answers[next][0])) {
      scanned = output.length;
      child.stdin.write(answers[next++][1]);
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, output };
}
