const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_500) });
    const body = await response.json() as { status?: unknown };
    if (!response.ok || body.status !== "ready") process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
