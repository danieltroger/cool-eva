/** Each attempt must finish its process/profile cleanup before rejecting. */
export async function retryHeadlessLaunch<Result>(browserPath: string, launch: () => Promise<Result>): Promise<Result> {
  const launchFailures: unknown[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await launch();
    } catch (launchError) {
      launchFailures.push(launchError);
      if (attempt === 1) {
        console.warn(`headless-page: ${browserPath} failed to start; retrying once`, launchError);
      }
    }
  }
  throw new AggregateError(launchFailures, `${browserPath} failed to start after 2 attempts`);
}
